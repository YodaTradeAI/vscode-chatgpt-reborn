import fs from "fs";
import upath from 'upath';
import { v4 as uuidv4 } from "uuid";
import vscode from 'vscode';
import { ApiProvider } from "./api-provider";
import { ActionNames, Conversation, Message, Model, Role } from "./renderer/types";
import { listItems } from "./utils";

export class ActionRunner {
  public static runAction(actionName: ActionNames, apiProvider: ApiProvider, systemContext: string, controller: AbortController): Promise<void> {
    const action = ActionRunner.getAction(actionName);
    if (!action) {
      throw new Error(`Action ${actionName} not found`);
    }
    return action.run(apiProvider, systemContext, controller);
  }

  private static getAction(actionName: ActionNames): Action | undefined {
    switch (actionName) {
      case ActionNames.createReadmeFromPackageJson:
        return new ReadmeFromPackageJSONAction() as Action;
      case ActionNames.createReadmeFromFileStructure:
        return new ReadmeFromFileStructure() as Action;
      case ActionNames.createGitignore:
        return new GitignoreAction() as Action;
      default:
        console.error(`Action ${actionName} not found`);
        return undefined;
    }
  }
}

class Action {

  // async iterator
  protected async* streamChatCompletion(apiProvider: ApiProvider, systemContext: string, prompt: string, abortSignal: AbortSignal): AsyncGenerator<any, any, unknown> {
    const systemMessage: Message = {
      id: uuidv4(),
      content: systemContext,
      rawContent: systemContext,
      role: Role.system,
      createdAt: Date.now(),
    };

    const message: Message = {
      id: uuidv4(),
      content: prompt,
      rawContent: prompt,
      role: Role.assistant,
      createdAt: Date.now(),
    };

    const conversation: Conversation = {
      id: uuidv4(),
      messages: [systemMessage, message],
      createdAt: Date.now(),
      inProgress: true,
      model: Model.gpt_35_turbo,
      autoscroll: true,
    };

    for await (const token of apiProvider.streamChatCompletion(conversation, abortSignal)) {
      yield token;
    }
  }

  public run(apiProvider: ApiProvider,
    systemContext: string,
    controller: AbortController
  ): Promise<void> {
    throw new Error('Not implemented');
  }
}

class ReadmeFromPackageJSONAction extends Action {
  public async run(apiProvider: ApiProvider,
    systemContext: string,
    controller: AbortController
  ): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      throw new Error('No workspace folder found.');
    }
    const currentProjectDir = vscode.workspace.workspaceFolders[0].uri.fsPath;

    // 0. Check if README.md exists. If it does, exit with an error.
    const readmePath = upath.join(currentProjectDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      throw new Error('README.md already exists.');
    } else {
      // Create an empty README.md file and open it in the editor
      fs.writeFileSync(readmePath, '');
      const document = await vscode.workspace.openTextDocument(readmePath);
      await vscode.window.showTextDocument(document);
    }

    // 1. Look for a package.json file in the current directory
    const packageJsonPath = upath.join(currentProjectDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error('package.json not found.');
    }

    // 2. Read the package.json file and extract the necessary fields
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const { name, displayName, license, description, repository, scripts, dependencies, devDependencies, homepage, engines, main } = packageJson;

    // 3. Check if either a package-lock.json or yarn.lock file exists. Save into a variable which lockfile is used.
    const lockfile = fs.existsSync(upath.join(currentProjectDir, 'package-lock.json')) ? 'package-lock.json' : (fs.existsSync(upath.join(currentProjectDir, 'yarn.lock')) ? 'yarn.lock' : '');

    // Get files + folders in the current project directory (note: this only goes 3 levels deep and ignores .gitignore files)
    let filesAndFolders = listItems(currentProjectDir);
    // Convert absolute paths to relative paths
    filesAndFolders = filesAndFolders.map((fileOrFolder: string) => fileOrFolder.replace(`${currentProjectDir}/`, ''));

    // If .git/config exists, attempt to extract the repository URL from it
    const gitConfigPath = upath.join(currentProjectDir, '.git/config');
    let repositoryUrl = '';
    if (fs.existsSync(gitConfigPath)) {
      const gitConfigContents = fs.readFileSync(gitConfigPath, 'utf8');
      // Find the repository URL in the git config using some string matching or parsing
      // For example, if the URL is always surrounded by square brackets:
      const matches = gitConfigContents.match(/\[remote "origin"\]\s*url\s*=\s*(.*)/);
      if (matches) {
        repositoryUrl = matches[1];
      }
    }

    // 4. Run streamChatCompletion, stream the response into a new file called README.md
    // 4.1. Use the information above to write the prompt to ask the AI to generate the README.md file.
    const prompt = `Generate a README.md GitHub markdown file for a project based on the following details:
    - Name: ${displayName || name}
    - Description: ${description}${repositoryUrl ? `
    - Repository URL: ${repositoryUrl}` : ''}
    - License: ${license}
    - Repository: ${repository?.url}
    - Version: ${packageJson.version}
    - Scripts: ${JSON.stringify(scripts)}
    - Dependencies: ${JSON.stringify(dependencies)}
    - Dev Dependencies: ${JSON.stringify(devDependencies)}
    - Homepage: ${homepage}
    - Engines: ${JSON.stringify(engines)}
    - Main: ${main}
    - Lockfile: ${lockfile}
    - Files/folders in this project: ${JSON.stringify(filesAndFolders)}
    `;

    const systemContextModified = `Using the information provided in the package.json file and the details about the files in the project directory, please generate a comprehensive and well-structured README.md file in GitHub markdown for the project. Include the following sections:
- Project Title and Description: Extract the project name and a brief description from the package.json file. Also optionally include badges for the project's license, version, and build status.
- Table of Contents: Create a table of contents with clickable links to the different sections of the README.
- Installation: Provide clear instructions on how to install the project and its dependencies, using the information from the package.json file.
- Usage: Explain how to use the project, including any available commands or scripts found in the package.json file.
- Project Overview: Describe the organization of the project files and their respective functions, only include important subdirectories. Do not include every single file, but rather the most important ones.
- Contributing: Explain how others can contribute to the project, including any contribution guidelines or best practices.
- Testing: If applicable, provide instructions for running tests, using the information from the package.json file.
- License: Include the project's license information, as specified in the package.json file.
- Acknowledgements: Mention any noteworthy contributors, libraries, or frameworks used in the project.
Please ensure the README.md file is well-formatted, easy to read, and provides all necessary information for users to understand, install, and utilize the project effectively.`;

    // Create a write stream for the README.md file
    const writeStream = fs.createWriteStream(readmePath, 'utf8');

    try {
      // Stream ChatGPT response directly to the write stream
      for await (const token of this.streamChatCompletion(apiProvider, systemContextModified, prompt, controller.signal)) {
        writeStream.write(token);
      }
    } catch (error) {
      console.error(error);
    } finally {
      // Close the write stream
      writeStream.end();
    }
  }
}

class ReadmeFromFileStructure extends Action {
  public async run(apiProvider: ApiProvider,
    systemContext: string,
    controller: AbortController
  ): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      throw new Error('No workspace folder found.');
    }
    const currentProjectDir = vscode.workspace.workspaceFolders[0].uri.fsPath;

    const readmePath = upath.join(currentProjectDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      throw new Error('README.md already exists.');
    } else {
      fs.writeFileSync(readmePath, '');
      const document = await vscode.workspace.openTextDocument(readmePath);
      await vscode.window.showTextDocument(document);
    }

    let filesAndFolders = listItems(currentProjectDir);
    filesAndFolders = filesAndFolders.map((fileOrFolder: string) => fileOrFolder.replace(`${currentProjectDir}/`, ''));

    // If .git/config exists, attempt to extract the repository URL from it
    const gitConfigPath = upath.join(currentProjectDir, '.git/config');
    let repositoryUrl = '';
    if (fs.existsSync(gitConfigPath)) {
      const gitConfigContents = fs.readFileSync(gitConfigPath, 'utf8');
      // Find the repository URL in the git config using some string matching or parsing
      // For example, if the URL is always surrounded by square brackets:
      const matches = gitConfigContents.match(/\[remote "origin"\]\s*url\s*=\s*(.*)/);
      if (matches) {
        repositoryUrl = matches[1];
      }
    }

    // Check if either a package-lock.json or yarn.lock file exists. Save into a variable which lockfile is used.
    const lockfile = fs.existsSync(upath.join(currentProjectDir, 'package-lock.json')) ? 'package-lock.json' : (fs.existsSync(upath.join(currentProjectDir, 'yarn.lock')) ? 'yarn.lock' : '');

    const prompt = `Generate a README.md GitHub markdown file for a project based on the following files/folders in this project: ${JSON.stringify(filesAndFolders)}

- Repository URL: ${repositoryUrl}
- Lockfile: ${lockfile}
`;

    const systemContextModified = `Using the information provided from the project structure, generate a comprehensive and well-structured README.md file in GitHub markdown format. Organize the information into the following sections:
- Project Title and Description: Extract the project name and a brief description from the package.json file. Also optionally include badges for the project's license, version, and build status.
- Table of Contents: Create a table of contents with clickable links to the different sections of the README.
- Installation: Provide clear instructions on how to install the project and its dependencies, using the information from the package.json file.
- Usage: Explain how to use the project, including any available commands or scripts found in the package.json file.
- Project Overview: Describe the organization of the project files and their respective functions, only include important subdirectories. Do not include every single file, but rather the most important ones.
- Contributing: Explain how others can contribute to the project, including any contribution guidelines or best practices.
- Testing: If applicable, provide instructions for running tests, using the information from the package.json file.
- License: Include the project's license information, as specified in the package.json file.
- Acknowledgements: Mention any noteworthy contributors, libraries, or frameworks used in the project.
Please ensure the README.md file is well-formatted, easy to read, and provides all necessary information for users to understand, install, and utilize the project effectively.`;

    const writeStream = fs.createWriteStream(readmePath, 'utf8');

    try {
      for await (const token of this.streamChatCompletion(apiProvider, systemContextModified, prompt, controller.signal)) {
        writeStream.write(token);
      }
    } catch (error) {
      console.error(error);
    } finally {
      writeStream.end();
    }
  }
}

class GitignoreAction extends Action {
  public async run(apiProvider: ApiProvider, systemContext: string, controller: AbortController): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      throw new Error('No workspace folder found.');
    }
    const currentProjectDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const packageJsonPath = upath.join(currentProjectDir, 'package.json');
    const gitignorePath = upath.join(currentProjectDir, '.gitignore');

    let packageJsonData = {} as any;
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const installedPackages = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).join(', ');
      packageJsonData = {
        installedPackages,
        homepage: packageJson.homepage,
        engines: packageJson.engines,
        main: packageJson.main,
      };
    }

    // Check if either a package-lock.json or yarn.lock file exists. Save into a variable which lockfile is used.
    const lockfile = fs.existsSync(upath.join(currentProjectDir, 'package-lock.json')) ? 'package-lock.json' : (fs.existsSync(upath.join(currentProjectDir, 'yarn.lock')) ? 'yarn.lock' : '');

    const document = await vscode.workspace.openTextDocument(gitignorePath);
    await vscode.window.showTextDocument(document);

    const filesAndFolders = listItems(currentProjectDir)
      .filter((f: string) => !/^\..*/.test(f) && !f.includes('node_modules'))
      .map((f: string) => f.replace(`${currentProjectDir}/`, ''));


    const prompt = `Specify any additional directories or files to ignore in your .gitignore file, separated by a space. Leave blank if none. Some details about the project:
    ${packageJsonData ? `
    - Installed Packages: ${packageJsonData.installedPackages}
    - Homepage: ${packageJsonData.homepage}
    - Engines: ${packageJsonData.engines}
    - Main: ${packageJsonData.main}
    ` : ''}
    - Lockfile: ${lockfile}
    - Files/folders in this project: ${JSON.stringify(filesAndFolders)}
    `;

    const systemContextModified = `Please create a well-structured .gitignore file for a typical software development project. The file should include common patterns and file types to be excluded from version control, such as:

    Operating system and editor-specific files, like .DS_Store, Thumbs.db, and .vscode.
    If applicable for this project, compiled files, build, and distribution directories, including .class, .exe, .jar, .war, and /dist.
    Any log files, cache, or temporary files this type of project might generate during the development process.
    Sensitive data, like API keys, secrets, and configuration files containing sensitive information.
    Do not include package-lock.json or yarn.lock in the .gitignore file.

Please ensure the .gitignore file is well-organized, easy to understand. The types of files in the .gitignore should be relevant to the project, and not just a generic list of common patterns.`;

    const writeStream = fs.createWriteStream(gitignorePath, 'utf8');

    try {
      for await (const token of this.streamChatCompletion(apiProvider, systemContextModified, prompt, controller.signal)) {
        writeStream.write(token);
      }
    } catch (error) {
      console.error(error);
    } finally {
      writeStream.end();
    }
  }
}
