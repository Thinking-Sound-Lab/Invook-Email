import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import axios, { type AxiosRequestConfig } from "axios";

import {
  GMAIL_MESSAGE_LIST_MAX_RESULTS,
  getGmailMessage,
  listGmailMessages,
} from "./client";

const originalAxiosRequest = axios.request;
const requests: AxiosRequestConfig[] = [];

before(() => {
  axios.request = (async (configuration: AxiosRequestConfig) => {
    requests.push(configuration);
    return { data: { messages: [], raw: "cmF3" } };
  }) as typeof axios.request;
});

after(() => {
  axios.request = originalAxiosRequest;
});

test("complete Gmail message pages use the provider maximum with Spam and Trash", async () => {
  requests.length = 0;
  await listGmailMessages("access-token", { pageToken: "next-page" });

  assert.equal(GMAIL_MESSAGE_LIST_MAX_RESULTS, 500);
  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(request.baseURL, "https://gmail.googleapis.com/gmail/v1");
  assert.equal(url.pathname, "/users/me/messages");
  assert.equal(url.searchParams.get("includeSpamTrash"), "true");
  assert.equal(url.searchParams.get("maxResults"), "500");
  assert.equal(url.searchParams.get("pageToken"), "next-page");
});

test("each listed Gmail message is fetched as raw MIME", async () => {
  requests.length = 0;
  await getGmailMessage("access-token", "message/with spaces");

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(request.baseURL, "https://gmail.googleapis.com/gmail/v1");
  assert.equal(url.pathname, "/users/me/messages/message%2Fwith%20spaces");
  assert.equal(url.searchParams.get("format"), "raw");
});
