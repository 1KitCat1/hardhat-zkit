import path from "path";
import os from "os";
import fs from "fs";
import { randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import * as snarkjs from "snarkjs";

import { HardhatRuntimeEnvironment } from "hardhat/types";

import { CircomCompilerFactory } from "./CircomCompilerFactory";
import { ICircomCompiler, CompilationProccessorConfig, CompilationInfo } from "../../types/compile";
import { ContributionTemplateType, ZKitConfig } from "../../types/zkit-config";

import { ResolvedFile } from "../dependencies";
import { PtauDownloader } from "../utils/PtauDownloader";
import { getNormalizedFullPath } from "../../utils/path-utils";
import { HardhatZKitError } from "../../errors";
import { PTAU_FILE_REG_EXP } from "../../constants";
import { readDirRecursively } from "../../utils/utils";
import { Reporter } from "../../reporter/Reporter";

export class CompilationProcessor {
  private readonly _zkitConfig: ZKitConfig;
  private readonly _compiler: ICircomCompiler;
  private readonly _verbose: boolean;

  constructor(
    private readonly _circuitsDirFullPath: string,
    private readonly _artifactsDirFullPath: string,
    private readonly _ptauDirFullPath: string,
    private readonly _config: CompilationProccessorConfig,
    hre: HardhatRuntimeEnvironment,
  ) {
    this._zkitConfig = hre.config.zkit;
    this._compiler = CircomCompilerFactory.createCircomCompiler(_config.compilerVersion);
    this._verbose = hre.hardhatArguments.verbose;
  }

  public async compile(filesToCompile: ResolvedFile[], quiet: boolean = true) {
    if (filesToCompile.length > 0) {
      const tempDir: string = path.join(os.tmpdir(), ".zkit", uuid());
      fs.mkdirSync(tempDir, { recursive: true });

      if (!quiet) {
        Reporter!.reportCompilationProcessHeader();
      }

      const compilationInfoArr: CompilationInfo[] = await this._getCompilationInfoArr(tempDir, filesToCompile);

      await this._compileCircuits(compilationInfoArr, quiet);

      const ptauFilePath: string = await this._getPtauFile(compilationInfoArr, quiet);

      await this._generateZKeyFiles(ptauFilePath, compilationInfoArr, quiet);
      await this._generateVKeyFile(compilationInfoArr, quiet);

      await this._moveFromTemDirToArtifacts(compilationInfoArr);

      if (!quiet) {
        Reporter!.reportCompilationResult(compilationInfoArr);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      Reporter!.reportNothingToCompile();
    }
  }

  private async _compileCircuits(compilationInfoArr: CompilationInfo[], quiet: boolean) {
    for (const info of compilationInfoArr) {
      const spinnerId: string = `${info.circuitName}-compile`;

      if (!quiet) {
        Reporter!.createSpinner(spinnerId, `Compiling ${info.circuitName} circuit`);
      }

      fs.mkdirSync(info.tempArtifactsPath, { recursive: true });

      const startTime: number = Date.now();

      await this._compiler.compile({
        circuitFullPath: info.resolvedFile.absolutePath,
        artifactsFullPath: info.tempArtifactsPath,
        compileFlags: this._config.compileFlags,
        quiet: !this._verbose,
      });

      if (!quiet) {
        Reporter!.reportCircuitCompilationResult(spinnerId, info.circuitName, startTime);
      }
    }
  }

  private async _generateZKeyFiles(ptauFilePath: string, compilationInfoArr: CompilationInfo[], quiet: boolean) {
    const contributions: number = this._zkitConfig.compilationSettings.contributions;
    const contributionTemplate: ContributionTemplateType = this._zkitConfig.compilationSettings.contributionTemplate;

    if (!quiet) {
      Reporter!.reportZKeyFilesGenerationHeader(contributions);
    }

    for (const info of compilationInfoArr) {
      const r1csFile = getNormalizedFullPath(info.tempArtifactsPath, `${info.circuitName}.r1cs`);
      const zKeyFile = getNormalizedFullPath(info.tempArtifactsPath, `${info.circuitName}.zkey`);

      const spinnerId: string = `${info.circuitName}-generate-zkey`;
      const startTime: number = Date.now();

      if (!quiet) {
        Reporter!.createSpinner(spinnerId, `Generating ZKey file for ${info.circuitName} circuit`);
      }

      if (contributionTemplate === "groth16") {
        await snarkjs.zKey.newZKey(r1csFile, ptauFilePath, zKeyFile);

        const zKeyFileNext = `${zKeyFile}.next.zkey`;

        for (let i = 0; i < contributions; ++i) {
          await snarkjs.zKey.contribute(
            zKeyFile,
            zKeyFileNext,
            `${zKeyFile}_contribution_${i}`,
            randomBytes(32).toString("hex"),
          );

          fs.rmSync(zKeyFile);
          fs.renameSync(zKeyFileNext, zKeyFile);
        }
      } else {
        throw new HardhatZKitError(`Unsupported contribution template - ${contributionTemplate}`);
      }

      if (!quiet) {
        Reporter!.reportZKeyFileGenerationResult(spinnerId, info.circuitName, contributions, startTime);
      }
    }
  }

  private async _generateVKeyFile(compilationInfoArr: CompilationInfo[], quiet: boolean) {
    if (!quiet) {
      Reporter!.reportVKeyFilesGenerationHeader();
    }

    for (const info of compilationInfoArr) {
      const spinnerId: string = `${info.circuitName}-generate-zkey`;
      const startTime: number = Date.now();

      if (!quiet) {
        Reporter!.createSpinner(spinnerId, `Generating VKey file for ${info.circuitName} circuit`);
      }

      const zkeyFile = getNormalizedFullPath(info.tempArtifactsPath, `${info.circuitName}.zkey`);
      const vKeyFile = getNormalizedFullPath(info.tempArtifactsPath, `${info.circuitName}.vkey.json`);

      const vKeyData = await snarkjs.zKey.exportVerificationKey(zkeyFile);

      fs.writeFileSync(vKeyFile, JSON.stringify(vKeyData));

      if (!quiet) {
        Reporter!.reportVKeyFileGenerationResult(spinnerId, info.circuitName, startTime);
      }
    }
  }

  private async _moveFromTemDirToArtifacts(compilationInfoArr: CompilationInfo[]) {
    compilationInfoArr.forEach((info: CompilationInfo) => {
      fs.mkdirSync(info.artifactsPath, { recursive: true });

      readDirRecursively(info.tempArtifactsPath, (dir: string, file: string) => {
        const correspondingOutDir = path.join(info.artifactsPath, path.relative(info.tempArtifactsPath, dir));
        const correspondingOutFile = path.join(info.artifactsPath, path.relative(info.tempArtifactsPath, file));

        if (!fs.existsSync(correspondingOutDir)) {
          fs.mkdirSync(correspondingOutDir);
        }

        if (fs.existsSync(correspondingOutFile)) {
          fs.rmSync(correspondingOutFile);
        }

        fs.copyFileSync(file, correspondingOutFile);
      });
    });
  }

  private async _getCompilationInfoArr(tempDir: string, filesToCompile: ResolvedFile[]): Promise<CompilationInfo[]> {
    return Promise.all(
      filesToCompile.map(async (file: ResolvedFile): Promise<CompilationInfo> => {
        const circuitName: string = path.parse(file.absolutePath).name;
        const tempArtifactsPath: string = getNormalizedFullPath(tempDir, file.sourceName);

        return {
          circuitName: circuitName,
          artifactsPath: file.absolutePath.replace(this._circuitsDirFullPath, this._artifactsDirFullPath),
          tempArtifactsPath,
          resolvedFile: file,
          constraintsNumber: 0,
        };
      }),
    );
  }

  private async _getPtauFile(compilationInfoArr: CompilationInfo[], quiet: boolean): Promise<string> {
    const circuitsConstraintsNumber: number[] = await Promise.all(
      compilationInfoArr.map(async (info: CompilationInfo) => {
        const constraintsNumber: number = this._getConstraintsNumber(info);
        info.constraintsNumber = constraintsNumber;

        return constraintsNumber;
      }),
    );

    const maxConstraintsNumber = Math.max(...circuitsConstraintsNumber);
    const ptauId = Math.max(Math.ceil(Math.log2(maxConstraintsNumber)), 8);

    let entries = [] as fs.Dirent[];

    if (fs.existsSync(this._ptauDirFullPath)) {
      entries = fs.readdirSync(this._ptauDirFullPath, { withFileTypes: true });
    }

    const entry = entries.find((entry) => {
      if (!entry.isFile()) {
        return false;
      }

      const match = entry.name.match(PTAU_FILE_REG_EXP);

      if (!match) {
        return false;
      }

      return ptauId <= parseInt(match[1]);
    });

    const ptauFileFullPath: string | undefined = entry
      ? getNormalizedFullPath(this._ptauDirFullPath, entry.name)
      : undefined;

    if (!quiet) {
      Reporter!.reportPtauFileInfo(maxConstraintsNumber, ptauId, ptauFileFullPath);
    }

    if (ptauFileFullPath) {
      return ptauFileFullPath;
    } else {
      return PtauDownloader.downloadPtau(this._ptauDirFullPath, ptauId, quiet);
    }
  }

  private _getConstraintsNumber(compilationInfo: CompilationInfo): number {
    const r1csFileName = `${compilationInfo.circuitName}.r1cs`;
    const r1csFile = getNormalizedFullPath(compilationInfo.tempArtifactsPath, r1csFileName);
    const r1csDescriptor = fs.openSync(r1csFile, "r");

    const readBytes = (position: number, length: number): bigint => {
      const buffer = Buffer.alloc(length);

      fs.readSync(r1csDescriptor, buffer, { length, position });

      return BigInt(`0x${buffer.reverse().toString("hex")}`);
    };

    /// @dev https://github.com/iden3/r1csfile/blob/d82959da1f88fbd06db0407051fde94afbf8824a/doc/r1cs_bin_format.md#format-of-the-file
    const numberOfSections = readBytes(8, 4);
    let sectionStart = 12;

    for (let i = 0; i < numberOfSections; ++i) {
      const sectionType = Number(readBytes(sectionStart, 4));
      const sectionSize = Number(readBytes(sectionStart + 4, 8));

      /// @dev Reading header section
      if (sectionType == 1) {
        const totalConstraintsOffset = 4 + 8 + 4 + 32 + 4 + 4 + 4 + 4 + 8;

        return Number(readBytes(sectionStart + totalConstraintsOffset, 4));
      }

      sectionStart += 4 + 8 + sectionSize;
    }

    throw new HardhatZKitError(`Header section in ${r1csFileName} file is not found.`);
  }
}
