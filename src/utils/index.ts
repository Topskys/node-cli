import ora from "ora";
import chalk from "chalk";
import * as path from "path";
import * as fs from "fs-extra";
import axios from "axios";
import * as pkg from "../../package.json";
import { HTTP_URL_REGEX, NPM_URL, PACKAGE_MANAGER, TEMPLATE_FILE } from "./constants";
import { LoadingOptions, TemplateInfo } from "./types";
import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git";
import ProgressEstimator, { LogOption } from "progress-estimator";

// 重试次数
let retryCount = 0;

/**
 * 异步加载函数
 *
 * @param options 加载参数配置，包含回调函数
 * @param args 传递给回调函数的参数
 * @returns 回调函数执行的结果
 */
export async function loading(options: LoadingOptions, ...args) {
  // 解构参数
  const {
    text = "loading...",
    cb,
    okText = "ok",
    failureText = "failure",
    maxRetries = 2,
    retryDelay = 200,
    color = "yellow",
  } = options;

  //  实例化加载动画
  const spinner = ora({
    text,
    color,
  });
  spinner.start();

  // 执行回调函数并等待其返回结果，如果执行失败则进行重试
  try {
    const result = await cb(...args);
    spinner.succeed(okText);
    return result;
  } catch (e) {
    if (retryCount <= maxRetries) {
      retryCount++;
      spinner.fail("Failure, reTrying...");
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          resolve();
        }, retryDelay);
      });
      return loading(options, ...args);
    } else {
      spinner.fail(failureText);
      return; // 终止程序
    }
  }
}

/**
 * 获取指定npm包的最新版本号
 *
 * @param name npm包名称
 * @returns 返回npm包的最新版本号，如果获取失败则返回undefined
 */
export async function getNpmLatestVersion(name: string) {
  let version: string;
  try {
    const npmPackageInfo = await axios.get(`${NPM_URL}${name}`);
    version = npmPackageInfo.data["dist-tags"].latest;
  } catch (err) {
    console.warn(chalk.yellow(`Can not get latest version of ${name}`));
  }
  return version;
}

/**
 * 比较两个版本号的大小
 *
 * @param v1 第一个版本号，默认为 "0.0.0"
 * @param v2 第二个版本号，默认为 "0.0.0"
 * @param len 版本号的长度，默认为 3
 * @returns 如果 v1 大于 v2，则返回 true；否则返回 false
 */
function gt(v1 = "0.0.0", v2 = "0.0.0", len = 3) {
  const pad = (v) =>
    v.split(".").map(Number).concat(Array(len).fill(0)).slice(0, len);
  const [a, b] = [v1, v2].map(pad);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * 检查指定包是否有更新版本
 *
 * @param name 包名
 * @param version 当前版本号
 */
export async function checkVersion(name: string, version: string) {
  const latestVersion = await getNpmLatestVersion(name);
  const needUpdate = gt(latestVersion, version);
  if (needUpdate) {
    console.warn(
      `Detected latest version of action-cli: ${chalk.blackBright(
        latestVersion
      )}. Your current version is: ${chalk.blackBright(version)}`
    );
    console.log(
      `To update, use ${chalk.yellow(
        "npm install action-cli@latest -g"
      )}, or alternatively, run ${chalk.yellow("action update")}`
    );
  }
}

const templatesPath = path.resolve(__dirname, TEMPLATE_FILE);

/**
 * 读取模板文件
 *
 * @returns 返回一个Promise，解析为模板对象数组
 */
export function readTemplates() {
  if (!fs.existsSync(templatesPath)) {
    fs.outputFileSync(templatesPath, "{}");
  }
  return new Promise((resolve, reject) => {
    fs.readFile(templatesPath, "utf8", (err, data) => {
      if (err) reject(chalk.red(`Can not read ${path} \n ${err}`));
      if (!data) reject(chalk.redBright("Error: templates.json is required\n"));
      resolve(JSON.parse(data));
    });
  });
}

/**
 * 同步读取模板文件
 *
 * @returns 模板对象
 */
export function readTemplateSync() {
  let templates: any = {};
  try {
    templates = fs.readJsonSync(templatesPath);
  } catch (e) {
    console.error(chalk.redBright("Error: template is required\n"));
  }
  return templates;
}

const logger = ProgressEstimator();

/**
 * 下载进度函数
 *
 * @param cb 一个返回 Promise 的函数
 * @param loadingText 加载提示文字，默认为 "downloading..."
 * @param options 可选参数，包含日志选项
 * @returns 返回传入函数的 Promise 结果
 */
export async function downloadProgress<T>(
  cb: Promise<T>,
  loadingText = "downloading...",
  options?: LogOption
) {
  const { estimate = 7 * 1000 } = options || {};
  return await logger(cb, loadingText, { estimate });
}

/**
 * 使用git克隆项目
 *
 * @param projectName 项目名称
 * @param templateInfo 模板信息对象，包含模板的URL和分支信息
 */
export async function gitClone(
  projectName: string,
  templateInfo: TemplateInfo
) {
  const options: Partial<SimpleGitOptions> = {
    baseDir: process.cwd(), // 工作目录
    binary: "git", // git二进制文件
    maxConcurrentProcesses: 6, // 最大并发进程数
    trimmed: false, // 是否去除git命令的输出中的换行符和前缀
  };
  const git = simpleGit(options);
  await git.clone(templateInfo.url, projectName, ["-b", templateInfo.branch]);
}

/**
 * 获取仓库的默认分支名
 *
 * @param url 仓库的URL
 * @param defBranch 仓库默认分支 main
 * @returns 默认分支名
 */
export function getDefaultBranch(url: string, defBranch = "main") {
  return url.includes("gitee.com") ? "master" : defBranch;
}

/**
 * 判断传入的包管理器名称是否为有效的包管理器名称，如果不是则返回默认包管理器名称
 *
 * @param name 待判断的包管理器名称
 * @param pm 默认包管理器名称，默认为 "pnpm"
 * @returns 如果传入的包管理器名称有效，则返回该名称；否则返回默认包管理器名称
 */
export function isPackageManger(name: string, pm = "pnpm") {
  return PACKAGE_MANAGER.includes(name) ? name : pm;
}

// 获取项目根目录下的 package.json 文件内容
export const getPackageJson = () => pkg;
