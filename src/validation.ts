/**
 * Shared input validation schemas used across all interfaces (MCP, CLI, Discord).
 * Single source of truth — avoids validation drift between interfaces.
 */
import { z } from "zod";

export const symbolSchema = z
  .string()
  .min(1, "Symbol is required")
  .max(10, "Symbol must be 10 characters or fewer")
  .regex(/^[A-Za-z]+$/, "Symbol must be letters only")
  .transform((s) => s.toUpperCase());

export const intervalSchema = z.enum(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);

/** Interval with default for MCP tools where it's optional. */
export const intervalSchemaWithDefault = intervalSchema.default("1h");

export const candlesSchema = z.coerce
  .number()
  .int("Candles must be a whole number")
  .min(1, "Candles must be at least 1")
  .max(500, "Candles must be 500 or fewer");

/** Candles with default for MCP tools where it's optional. */
export const candlesSchemaWithDefault = candlesSchema.default(100);

export const marketSchema = z.enum(["crypto", "stock", "commodity"]);

export const quantitySchema = z.coerce
  .number()
  .positive("Quantity must be positive")
  .max(1e12, "Quantity out of range");

export const priceSchema = z.coerce
  .number()
  .positive("Price must be positive")
  .max(1e12, "Price out of range");

export const thresholdSchema = z.coerce
  .number()
  .finite("Threshold must be a finite number");

export const descriptionSchema = z
  .string()
  .min(1, "Description is required")
  .max(2000, "Description must be 2000 characters or fewer");

export const notesSchema = z
  .string()
  .max(500, "Notes must be 500 characters or fewer")
  .optional();
