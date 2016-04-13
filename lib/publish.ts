import { execSync, exec as _exec } from 'child_process';
import * as path from 'path';
import * as pify from 'pify';
import * as fs from 'fs';

import mkdirp from './wrappers/mkdirp'
import rimraf from './wrappers/rimraf';
import unpack from './unpack';

interface PackageInfo {
    name: string;
    version: string
}

interface Options {
    commitText?: string;
    tagName?: string;
    tagMessageText?: string;
    tempDir?: string;
    packageInfo?: PackageInfo;
}

interface Params {
    commitTextOp: Promise<string>;
    tagNameOp: Promise<string>;
    tagMessageTextOp: Promise<string>;
    tempDir: string;
    packageInfo: PackageInfo;
}

interface Result {
    conclusion: publishExport.Conclusions
}

export default publishExport;
// new overload
function publishExport(packageDir: string,
    gitRemoteUrl: string,
    options?: Options): Promise<Result>;

// old deprecated overload
function publishExport(packageDir: string,
    gitRemoteUrl: string,
    commitText: string,
    tagName: string,
    tagMessageText: string,
    tempDir: string,
    packageInfo: PackageInfo): Promise<boolean>;

function publishExport(packageDir: string,
    gitRemoteUrl: string,
    options?: string | Options,
    tagName?: string,
    tagMessageText?: string,
    tempDir?: string,
    packageInfo?: PackageInfo): Promise<boolean | Result> {

    if (typeof options === 'string') {
        // using the deprecated overload
        return publish(packageDir, gitRemoteUrl, {
            commitTextOp: Promise.resolve(options),
            tagNameOp: Promise.resolve(tagName),
            tagMessageTextOp: Promise.resolve(tagMessageText),
            tempDir: tempDir,
            packageInfo: packageInfo
        })
            .then(result => result.conclusion === 'pushed');
    } else {
        // otherwise assume they want the new overload
        return provideDefaults(packageDir, gitRemoteUrl, options)
            .then(params => publish(packageDir, gitRemoteUrl, params));
    }
}

namespace publishExport {
    export const PUSHED : 'pushed' = 'pushed',
        SKIPPED : 'skipped' = 'skipped',
        CANCELLED : 'cancelled' = 'cancelled';
    export type Conclusions = typeof PUSHED | typeof SKIPPED | typeof CANCELLED;
}

function publish(packageDir: string, gitRemoteUrl: string, params: Params): Promise<Result> {
    const writeFile = pify(fs.writeFile),
        gitRepoDir = path.join(params.tempDir, 'repo'),
        packDir = path.join(params.tempDir, 'pack'),
        commitTextPath = path.join(params.tempDir, 'commitMessage.txt'),
        tagTextPath = path.join(params.tempDir, 'tagMessage.txt'),
        cleanupOperations: Promise<any>[] = [];

    // launch setup operations
    const initialCleanDone = rimraf(params.tempDir, { glob: false });
    const directoryReady = initialCleanDone.then(() => mkdirp(packDir));
    const commitTextWritten = Promise.all([params.commitTextOp, directoryReady])
        .then(([commitText]) => writeFile(commitTextPath, commitText));
    const tagTextWritten = Promise.all([params.tagMessageTextOp, directoryReady])
        .then(([tagMessageText]) => writeFile(tagTextPath, tagMessageText));

    // simultaneously ask NPM to pack up the package dir and create a clone of the remote URL
    const tarballCreated = packPackageIntoTarball();
    const doneCloning = cloneRemoteToTempRepo();

    // now do the update and push (if applicable)
    return replaceRepoWithPackContents()
        .then(stageAllRepoChanges)
        .then(queryRepoStatus)
        .then(hasChanges => hasChanges ? commitChanges() : Promise.resolve())
        .then(tagLastCommit)
        .then(pushDefaultBranch)
        .then(() => {
            cleanupOperations.push(rimraf(params.tempDir, { glob: false }));
            return Promise.all(cleanupOperations);
        })
        .then(() => ({ conclusion: 'pushed' }));

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // LOCAL HELPER FUNCTIONS

    function packPackageIntoTarball() {
        return directoryReady
            .then(() => exec(`npm pack "${packageDir}"`, { cwd: packDir }))
            .then((packCommandOutput) => {
                // pack succeeded! Schedule a cleanup and return the full path
                cleanupOperations.push(exec(`npm cache clean ${params.packageInfo.name}@${params.packageInfo.version}`));
                const packFileName = packCommandOutput.replace(/\r\n|\r|\n/g, '');
                return path.join(packDir, packFileName);
            });
    }

    function cloneRemoteToTempRepo() {
        return initialCleanDone.then(() => {
            execSync(`git clone --quiet --depth 1 ${gitRemoteUrl} "${gitRepoDir}"`, { stdio: 'inherit' });
        });
    }

    function replaceRepoWithPackContents() {
        // in order to allow for the new release to overwrite the old one (including possibly removing/renaming files),
        // we remove everything that was in the repo before. To do this, use an exclusionary glob.
        const cleanPattern = path.join(gitRepoDir, '!(.git)');
        // tell glob to treat the leading '.' in filename (e.g. Linux/Mac hidden files) as a normal character.
        // this is necessary so that we can successfully delete files that begin with '.'
        const cleanOptions = { glob: { dot: true } };

        const doneCleaning = doneCloning.then(() => rimraf(cleanPattern, cleanOptions));

        return Promise.all<any>([tarballCreated, doneCleaning])
            .then(([tarballPath] : [string]) => unpack(tarballPath, gitRepoDir));
    }

    function stageAllRepoChanges() {
        return exec(`git add --all`, { cwd: gitRepoDir });
    }

    function queryRepoStatus() {
        return exec(`git status --porcelain`, { cwd: gitRepoDir })
            .then((statusOutput) => {
                return statusOutput.trim().length !== 0;
            });
    }

    function commitChanges() {
        const commitCommandText = `git commit --file="${commitTextPath}" --allow-empty-message --no-verify`;
        return commitTextWritten.then(() => exec(commitCommandText, { cwd: gitRepoDir }));
    }

    function tagLastCommit() {
        return Promise.all([params.tagNameOp, tagTextWritten])
            .then(([tagName]) => exec(`git tag --annotate --file="${tagTextPath}" "${tagName}"`, { cwd: gitRepoDir }));
    }

    function pushDefaultBranch() {
        execSync(`git push --follow-tags origin HEAD`, { cwd: gitRepoDir, stdio: 'inherit' });
    }
}

function provideDefaults(packageDir: string, gitRemoteUrl: string, options?: Options) : Promise<Params> {
    options = options || {};

    if (options.packageInfo) {
        return Promise.resolve(provideRemainingDefaults(options.packageInfo));
    } else {
        const readPkg = require('read-pkg') as ((packageDir: string) => Promise<PackageInfo>);
        return readPkg(packageDir).then(provideRemainingDefaults);
    }

    function provideRemainingDefaults(packageInfo: PackageInfo) : Params {
        const versionOp = Promise.resolve(packageInfo.version),
            commitTextOp = options.commitText ? Promise.resolve(options.commitText) :
                versionOp.then(version => `release: version ${version}`);

        return {
            commitTextOp: commitTextOp,
            tagMessageTextOp: options.tagMessageText ? Promise.resolve(options.tagMessageText) : commitTextOp,
            tagNameOp: options.tagName ? Promise.resolve(options.tagName) : versionOp.then(version => `v${version}`),
            tempDir: options.tempDir || require('unique-temp-dir')() as string,
            packageInfo: packageInfo
        };
    }
}

// this has a compatible signature to promisified child_process.exec()
// the difference is that it prints out stdout/stderr if the command fails
function exec(command: string, options?: { cwd: string }) {
    return new Promise<string>((resolve, reject) => {
        _exec(command, options, (error, stdout, stderr) => {
            if (error) {
                if (stdout) {
                    console.log(stdout);
                }
                if (stderr) {
                    console.error(stderr);
                }
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}
