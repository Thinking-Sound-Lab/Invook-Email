export {
  gmailHistoryChanges,
  getGmailMessage,
  getGmailProfile,
  GmailApiError,
  listGmailHistory,
  listGmailMessages,
  refreshGoogleAccessToken,
  type GmailHistoryChange,
  type GmailMessage,
  type GmailHistoryPage,
  type GmailHistoryRecord,
  type GmailMessagePage,
  type GmailMessagePart,
  type GmailMessageReference,
  type GmailProfile,
} from "./client";
export {
  extractEmailAddress,
  isMemoryEligible,
  parseGmailMessage,
  type ParsedGmailMessage,
} from "./message";
export {
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  type GoogleAuthorizationRequest,
  type GoogleAuthorizationResult,
} from "./oauth";
export { GMAIL_SCOPE_DESCRIPTION, GMAIL_SCOPES } from "./scopes";
