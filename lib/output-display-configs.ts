export type OutputDisplayConfig = {
  type: "image" | "video" | "url";
  field: string;
};

export const OUTPUT_DISPLAY_CONFIGS: Record<string, OutputDisplayConfig> = {};
