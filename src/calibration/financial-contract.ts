import { ConflictError } from "./ports.js";

export interface FinancialOperationBinding {
  financialSchema: "internal-finance-v1";
  financialOperationId: string;
}

export function validateFinancialRequest(action: string, payload: Record<string, unknown>): void {
  for (const name of Object.keys(payload)) {
    if (name.startsWith("financial") && name !== "financialOperationKey") {
      throw new ConflictError("Client financial authority and balances are forbidden");
    }
  }
  if (!Object.hasOwn(payload, "financialOperationKey")) return;
  if (
    action !== "propose" ||
    typeof payload.financialOperationKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.financialOperationKey) ||
    /[^A-Za-z0-9._:-]/.test(payload.financialOperationKey)
  ) {
    throw new ConflictError("Invalid financial operation key; proposal required");
  }
}

export function financialResultKeys(result: Record<string, unknown>): string[] {
  if (!Object.hasOwn(result, "financialOperationId") && !Object.hasOwn(result, "financialSchema")) return [];
  if (
    result.financialSchema !== "internal-finance-v1" ||
    typeof result.financialOperationId !== "string" ||
    result.financialOperationId.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.financialOperationId)
  ) {
    throw new ConflictError("Invalid financial operation binding from engine");
  }
  return ["financialOperationId", "financialSchema"];
}

export function validateFinancialResponse(
  action: string,
  payload: Record<string, unknown>,
  result: Record<string, unknown>,
): string[] {
  const keys = financialResultKeys(result);
  if (action === "propose" && Object.hasOwn(payload, "financialOperationKey") !== keys.length > 0) {
    throw new ConflictError("Engine did not honor the requested financial mode");
  }
  return keys;
}
