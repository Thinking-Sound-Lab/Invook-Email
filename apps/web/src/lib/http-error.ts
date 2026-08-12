import axios from "axios";
import type { ApiProblem } from "@invook/contracts";

export function apiErrorMessage(error: unknown, fallback: string) {
  if (!axios.isAxiosError<Partial<ApiProblem>>(error)) return fallback;
  return error.response?.data?.title || fallback;
}
