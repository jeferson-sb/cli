import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {validateProjectName} from './validate';
import chalk from 'chalk';
import DirectoryAlreadyExistsError from './errors/DirectoryAlreadyExistsError';
import printRunInstructions from './printRunInstructions';
import {
  CLIError,
  logger,
  getLoader,
  Loader,
  cacheManager,
  prompt,
} from '@react-native-community/cli-tools';
import {installPods} from '@react-native-community/cli-platform-ios';
import {
  installTemplatePackage,
  getTemplateConfig,
  copyTemplate,
  executePostInitScript,
} from './template';
import {changePlaceholderInTemplate} from './editTemplate';
import * as PackageManager from '../../tools/packageManager';
import banner from './banner';
import TemplateAndVersionError from './errors/TemplateAndVersionError';
import {getBunVersionIfAvailable} from '../../tools/bun';
import {getNpmVersionIfAvailable} from '../../tools/npm';
import {getYarnVersionIfAvailable} from '../../tools/yarn';
import {createHash} from 'crypto';
import createGitRepository from './createGitRepository';
import deepmerge from 'deepmerge';

const DEFAULT_VERSION = 'latest';

type Options = {
  template?: string;
  npm?: boolean;
  pm?: PackageManager.PackageManager;
  directory?: string;
  displayName?: string;
  title?: string;
  skipInstall?: boolean;
  version?: string;
  packageName?: string;
  installPods?: string | boolean;
  platformName?: string;
  skipGitInit?: boolean;
};

interface TemplateOptions {
  projectName: string;
  templateUri: string;
  npm?: boolean;
  pm?: PackageManager.PackageManager;
  directory: string;
  projectTitle?: string;
  skipInstall?: boolean;
  packageName?: string;
  installCocoaPods?: string | boolean;
}

function doesDirectoryExist(dir: string) {
  return fs.existsSync(dir);
}

async function setProjectDirectory(directory: string) {
  if (doesDirectoryExist(directory)) {
    throw new DirectoryAlreadyExistsError(directory);
  }

  try {
    fs.mkdirSync(directory, {recursive: true});
    process.chdir(directory);
  } catch (error) {
    throw new CLIError(
      'Error occurred while trying to create project directory.',
      error as Error,
    );
  }

  return process.cwd();
}

function getTemplateName(cwd: string) {
  // We use package manager to infer the name of the template module for us.
  // That's why we get it from temporary package.json, where the name is the
  // first and only dependency (hence 0).
  const name = Object.keys(
    JSON.parse(fs.readFileSync(path.join(cwd, './package.json'), 'utf8'))
      .dependencies,
  )[0];
  return name;
}

//set cache to empty string to prevent installing cocoapods on freshly created project
function setEmptyHashForCachedDependencies(projectName: string) {
  cacheManager.set(
    projectName,
    'dependencies',
    createHash('md5').update('').digest('hex'),
  );
}

async function createFromTemplate({
  projectName,
  templateUri,
  npm,
  pm,
  directory,
  projectTitle,
  skipInstall,
  packageName,
  installCocoaPods,
}: TemplateOptions) {
  logger.debug('Initializing new project');
  logger.log(banner);

  let packageManager = pm;

  if (pm) {
    packageManager = pm;
  } else {
    const userAgentPM = userAgentPackageManager();
    // if possible, use the package manager from the user agent. Otherwise fallback to default (yarn)
    packageManager = userAgentPM || 'yarn';
  }

  if (npm) {
    logger.warn(
      'Flag --npm is deprecated and will be removed soon. In the future, please use --pm npm instead.',
    );

    packageManager = 'npm';
  }

  const projectDirectory = await setProjectDirectory(directory);

  const loader = getLoader({text: 'Downloading template'});
  const templateSourceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rncli-init-template-'),
  );

  try {
    loader.start();

    await installTemplatePackage(
      templateUri,
      templateSourceDir,
      packageManager,
    );

    loader.succeed();
    loader.start('Copying template');

    const templateName = getTemplateName(templateSourceDir);
    const templateConfig = getTemplateConfig(templateName, templateSourceDir);
    await copyTemplate(
      templateName,
      templateConfig.templateDir,
      templateSourceDir,
    );

    loader.succeed();
    loader.start('Processing template');

    await changePlaceholderInTemplate({
      projectName,
      projectTitle,
      placeholderName: templateConfig.placeholderName,
      placeholderTitle: templateConfig.titlePlaceholder,
      packageName,
    });

    createDefaultConfigFile(projectDirectory, loader);

    const {postInitScript} = templateConfig;
    if (postInitScript) {
      loader.info('Executing post init script ');
      await executePostInitScript(
        templateName,
        postInitScript,
        templateSourceDir,
      );
    }

    if (!skipInstall) {
      await installDependencies({
        packageManager,
        loader,
        root: projectDirectory,
      });

      if (process.platform === 'darwin') {
        const installPodsValue = String(installCocoaPods);

        if (installPodsValue === 'true') {
          await installPods(loader);
          loader.succeed();
          setEmptyHashForCachedDependencies(projectName);
        } else if (installPodsValue === 'undefined') {
          const {installCocoapods} = await prompt({
            type: 'confirm',
            name: 'installCocoapods',
            message: `Do you want to install CocoaPods now? ${chalk.reset.dim(
              'Only needed if you run your project in Xcode directly',
            )}`,
          });

          if (installCocoapods) {
            await installPods(loader);
            loader.succeed();
            setEmptyHashForCachedDependencies(projectName);
          }
        }
      }
    } else {
      loader.succeed('Dependencies installation skipped');
    }
  } catch (e) {
    loader.fail();
    throw e;
  } finally {
    fs.removeSync(templateSourceDir);
  }
}

async function installDependencies({
  packageManager,
  loader,
  root,
}: {
  packageManager: PackageManager.PackageManager;
  loader: Loader;
  root: string;
}) {
  loader.start('Installing dependencies');

  await PackageManager.installAll({
    packageManager,
    silent: true,
    root,
  });

  loader.succeed();
}

function checkPackageManagerAvailability(
  packageManager: PackageManager.PackageManager,
) {
  if (packageManager === 'bun') {
    return getBunVersionIfAvailable();
  } else if (packageManager === 'npm') {
    return getNpmVersionIfAvailable();
  } else if (packageManager === 'yarn') {
    return getYarnVersionIfAvailable();
  }

  return false;
}

function createTemplateUri(options: Options, version: string): string {
  const isTypescriptTemplate =
    options.template === 'react-native-template-typescript';

  // This allows to correctly retrieve template uri for out of tree platforms.
  const platform = options.platformName || 'react-native';

  if (isTypescriptTemplate) {
    logger.warn(
      "Ignoring custom template: 'react-native-template-typescript'. Starting from React Native v0.71 TypeScript is used by default.",
    );
    return platform;
  }

  return options.template || `${platform}@${version}`;
}

//remove quotes from object keys to match the linter rules of the template
function sanitizeConfigFile(fileContent: string) {
  return fileContent.replace(/"([^"]+)":/g, '$1:');
}

/*
Starting from 0.73, react-native.config.js is created by CLI during the init process.
It contains automaticPodsInstallation flag set to true by default.
This flag is used by CLI to determine whether to install CocoaPods dependencies when running ios commands or not.
It's created by CLI rather than being a part of a template to avoid displaying this file in the Upgrade Helper,
as it might bring confusion for existing projects where this change might not be applicable.
For more details, see https://github.com/react-native-community/cli/blob/main/docs/projects.md#projectiosautomaticpodsinstallation
*/
function createDefaultConfigFile(directory: string, loader: Loader) {
  const cliConfigContent = {
    project: {
      ios: {
        automaticPodsInstallation: true,
      },
    },
  };
  const configFileContent = `module.exports = ${JSON.stringify(
    cliConfigContent,
    null,
    2,
  )}`;
  const filepath = 'react-native.config.js';
  try {
    if (!doesDirectoryExist(path.join(directory, filepath))) {
      fs.writeFileSync(filepath, sanitizeConfigFile(configFileContent), {
        encoding: 'utf-8',
      });
    } else {
      const existingConfigFile = require(path.join(directory, filepath));

      const mergedConfig = deepmerge(existingConfigFile, cliConfigContent);
      const output = `module.exports = ${JSON.stringify(
        mergedConfig,
        null,
        2,
      )};`;

      fs.writeFileSync(filepath, sanitizeConfigFile(output), {
        encoding: 'utf-8',
      });
    }
    loader.succeed();
  } catch {
    loader.warn(
      `Could not create custom ${chalk.bold(
        'react-native.config.js',
      )} file. You can create it manually in your project's root folder with the following content: \n\n${configFileContent}`,
    );
  }
}

async function createProject(
  projectName: string,
  directory: string,
  version: string,
  options: Options,
) {
  const templateUri = createTemplateUri(options, version);

  return createFromTemplate({
    projectName,
    templateUri,
    npm: options.npm,
    pm: options.pm,
    directory,
    projectTitle: options.title,
    skipInstall: options.skipInstall,
    packageName: options.packageName,
    installCocoaPods: options.installPods,
  });
}

function userAgentPackageManager() {
  const userAgent = process.env.npm_config_user_agent;

  if (userAgent) {
    if (userAgent.startsWith('yarn')) {
      return 'yarn';
    }
    if (userAgent.startsWith('npm')) {
      return 'npm';
    }
    if (userAgent.startsWith('bun')) {
      return 'bun';
    }
  }

  return null;
}

export default (async function initialize(
  [projectName]: Array<string>,
  options: Options,
) {
  if (!projectName) {
    const {projName} = await prompt({
      type: 'text',
      name: 'projName',
      message: 'How would you like to name the app?',
    });
    projectName = projName;
  }

  validateProjectName(projectName);

  if (!!options.template && !!options.version) {
    throw new TemplateAndVersionError(options.template);
  }

  const root = process.cwd();
  const version = options.version || DEFAULT_VERSION;
  const directoryName = path.relative(root, options.directory || projectName);

  if (options.pm && !checkPackageManagerAvailability(options.pm)) {
    logger.error(
      'Seems like the package manager you want to use is not installed. Please install it or choose another package manager.',
    );
    return;
  }

  await createProject(projectName, directoryName, version, options);

  const projectFolder = path.join(root, directoryName);

  if (!options.skipGitInit) {
    await createGitRepository(projectFolder);
  }

  printRunInstructions(projectFolder, projectName);
});
