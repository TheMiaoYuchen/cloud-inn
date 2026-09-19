export type DesignProject = {
  id: string;
  name: string;
  templateId: string;
  furnitureIds: string[];
  stylePrompt: string;
  imageDataUrl?: string;
  updatedAt: string;
};

export type GenerateResponse = {
  image: { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" };
  model: string;
};

export type ApiError = {
  error: { code: string; message: string };
};
