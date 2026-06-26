/**
 * Beispiel-Domänendaten für das `lookup_customer`-Tool.
 */
import { Schema, model, type InferSchemaType } from "mongoose";

const CustomerSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String },
    notes: { type: String },
  },
  { timestamps: true, collection: "customers" },
);

export type CustomerDoc = InferSchemaType<typeof CustomerSchema>;
export const Customer = model("Customer", CustomerSchema);
