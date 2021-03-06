import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";

import { ChildProcess, fork } from "child_process";
import { validWarehouses } from "df/api/dbadapters";
import { coerceAsError, ErrorWithCause } from "df/common/errors/errors";
import { decode } from "df/common/protos";
import { dataform } from "df/protos/ts";

// Project config properties that are required.
const mandatoryProps: Array<keyof dataform.IProjectConfig> = ["warehouse", "defaultSchema"];

// Project config properties that require alphanumeric characters, hyphens or underscores.
const simpleCheckProps: Array<keyof dataform.IProjectConfig> = [
  "assertionSchema",
  "databaseSuffix",
  "schemaSuffix",
  "tablePrefix",
  "defaultSchema"
];

export class CompilationTimeoutError extends Error {}

export async function compile(
  compileConfig: dataform.ICompileConfig = {}
): Promise<dataform.CompiledGraph> {
  // Resolve the path in case it hasn't been resolved already.
  path.resolve(compileConfig.projectDir);

  // Create an empty projectConfigOverride if not set.
  compileConfig = { projectConfigOverride: {}, ...compileConfig };

  // Schema overrides field can be set in two places, projectConfigOverride.schemaSuffix takes precedent.
  if (compileConfig.schemaSuffixOverride) {
    compileConfig.projectConfigOverride = {
      schemaSuffix: compileConfig.schemaSuffixOverride,
      ...compileConfig.projectConfigOverride
    };
  }

  try {
    // check dataformJson is valid before we try to compile
    const dataformJson = fs.readFileSync(`${compileConfig.projectDir}/dataform.json`, "utf8");
    const projectConfig = JSON.parse(dataformJson);
    checkDataformJsonValidity({
      ...projectConfig,
      ...compileConfig.projectConfigOverride,
      vars: {
        ...projectConfig.vars,
        ...compileConfig.projectConfigOverride?.vars
      }
    });
  } catch (e) {
    throw new ErrorWithCause(
      `Compilation failed. ProjectConfig ('dataform.json') is invalid: ${e.message}`,
      e
    );
  }

  return decode(
    dataform.CompiledGraph,
    await CompileChildProcess.forkProcess().compile(compileConfig)
  );
}

export class CompileChildProcess {
  public static forkProcess() {
    // Runs the worker_bundle script we generate for the package (see packages/@dataform/cli/BUILD)
    // if it exists, otherwise run the bazel compile loader target.
    const findForkScript = () => {
      try {
        const workerBundlePath = require.resolve("./worker_bundle");
        return workerBundlePath;
      } catch (e) {
        return require.resolve("../vm/compile_loader");
      }
    };
    const forkScript = findForkScript();
    return new CompileChildProcess(
      fork(require.resolve(forkScript), [], { stdio: [0, 1, 2, "ipc", "pipe"] })
    );
  }
  private readonly childProcess: ChildProcess;

  constructor(childProcess: ChildProcess) {
    this.childProcess = childProcess;
  }

  public async compile(compileConfig: dataform.ICompileConfig) {
    const compileInChildProcess = new Promise<string>(async (resolve, reject) => {
      // Handle any Error caused by spawning the child process, or sent directly from the child process.
      this.childProcess.on("error", (e: Error) => reject(coerceAsError(e)));
      this.childProcess.on("message", (e: Error) => reject(coerceAsError(e)));

      // Handle UTF-8 string chunks returned by the child process.
      const pipe = this.childProcess.stdio[4] as Readable;
      const chunks: Buffer[] = [];
      pipe?.on("readable", () => {
        let buffer: Buffer = pipe.read();
        while (buffer) {
          chunks.push(buffer);
          buffer = pipe.read();
        }
      });

      // When the child process closes all stdio streams, return the compiled result.
      this.childProcess.on("close", exitCode => {
        if (exitCode === 0) {
          resolve(Buffer.concat(chunks).toString("utf8"));
        } else {
          reject(new Error(`Compilation child process exited with exit code ${exitCode}.`));
        }
      });

      // Trigger the child process to start compiling.
      this.childProcess.send(compileConfig);
    });
    let timer;
    const timeout = new Promise(
      (resolve, reject) =>
        (timer = setTimeout(
          () => reject(new CompilationTimeoutError("Compilation timed out")),
          compileConfig.timeoutMillis || 5000
        ))
    );
    try {
      await Promise.race([timeout, compileInChildProcess]);
      return await compileInChildProcess;
    } finally {
      if (!this.childProcess.killed) {
        this.childProcess.kill("SIGKILL");
      }
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export const checkDataformJsonValidity = (dataformJsonParsed: { [prop: string]: string }) => {
  const invalidWarehouseProp = () => {
    return dataformJsonParsed.warehouse && !validWarehouses.includes(dataformJsonParsed.warehouse)
      ? `Invalid value on property warehouse: ${
          dataformJsonParsed.warehouse
        }. Should be one of: ${validWarehouses.join(", ")}.`
      : null;
  };
  const invalidProp = () => {
    const invProp = simpleCheckProps.find(prop => {
      return prop in dataformJsonParsed && !/^[a-zA-Z_0-9\-]*$/.test(dataformJsonParsed[prop]);
    });
    return invProp
      ? `Invalid value on property ${invProp}: ${dataformJsonParsed[invProp]}. Should only contain alphanumeric characters, underscores and/or hyphens.`
      : null;
  };
  const missingMandatoryProp = () => {
    const missMandatoryProp = mandatoryProps.find(prop => {
      return !(prop in dataformJsonParsed);
    });
    return missMandatoryProp ? `Missing mandatory property: ${missMandatoryProp}.` : null;
  };
  const message = invalidWarehouseProp() || invalidProp() || missingMandatoryProp();
  if (message) {
    throw new Error(message);
  }
};
