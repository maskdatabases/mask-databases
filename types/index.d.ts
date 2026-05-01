// mask-databases — runtime types

export interface MaskQueryOptions {
  db?: any;
}

export interface MaskCallsite {
  file: string;
  line: number;
  column: number;
}

export interface MaskQuerySpec {
  type: string;
  collection?: string;
  query?: string;
  pipeline?: any[];
  cypher?: string;
  params?: string[];
  [key: string]: any;
}

export interface MaskModelSpec {
  collection: string;
  modelName?: string;
  fields: Record<string, any>;
  relations: any[];
  schemaOptions?: Record<string, any>;
}

export declare class MaskDatabase {
  static prompt(
    promptText: string,
    params?: Record<string, any>,
    options?: MaskQueryOptions
  ): Promise<any>;

  static getQueryForPrompt(promptText: string): MaskQuerySpec | null;

  static formatQuerySpec(spec: MaskQuerySpec): string;
}

export declare class MaskModels {
  static define(promptText: string): any;

  static getModelForPrompt(promptText: string): MaskModelSpec | null;

  static formatModelSpec(spec: MaskModelSpec): string;
}
