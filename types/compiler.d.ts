// mask-databases/compiler — compiler API types

export interface MaskOverrideConfig {
  database?: string;
  dbModulePath?: string;
  syncApiKey?: string;
  syncBaseUrl?: string;
  modelPaths?: string[];
  queryPaths?: string[];
  registery?: Record<string, string>;
  customClassNames?: {
    promptCallNames?: string[];
    modelDefineNames?: string[];
    customOnly?: boolean;
  };
}

export interface MaskCompileOptions {
  watch?: boolean;
  projectRoot?: string;
  overrideConfig?: MaskOverrideConfig;
}

export interface MaskConfig {
  database: string;
  dbModulePath: string;
  syncApiKey: string;
  syncBaseUrl?: string;
  modelPaths?: string[];
  queryPaths?: string[];
  registery?: Record<string, string>;
  language?: string;
}

export interface MaskConfigMeta {
  config: MaskConfig;
  configPath: string;
  projectRoot: string;
}

export declare function compileOnce(options?: MaskCompileOptions): Promise<void>;

export declare function runWithMaskConfig(options?: MaskCompileOptions): Promise<void>;

export declare function parseArgs(argv?: string[]): { watch: boolean };

export declare function loadConfig(paths: any): MaskConfig;

export declare function loadConfigWithMeta(projectRoot?: string): MaskConfigMeta;

export declare function loadOrCreateProjectProfile(config: MaskConfig, projectRoot: string): any;

export declare function readMaskConfigRawObject(configPath: string): Record<string, any> | null;

export declare function normalizeAndValidateConfig(raw: Record<string, any>): MaskConfig;

export declare function toMaterializedMaskConfigJson(config: MaskConfig): Record<string, any>;
