import type { ReactNode } from "react";
import type { DataPart } from "@usepatchwork/client";

export type BlockRenderer = (block: DataPart) => ReactNode;
export type RendererRegistry = Record<string, BlockRenderer>;
