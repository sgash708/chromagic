import { apiFetch } from "./github-api.mjs";

export const APPROVE_COMMAND = "/chromagic approve";

export function isApproveCommand(body) {
  return body.trim() === APPROVE_COMMAND;
}

export function isSelfApprove(commentAuthor, prAuthor) {
  return commentAuthor.toLowerCase() === prAuthor.toLowerCase();
}

export async function hasWritePermission({ repo, username, token, apiBase }) {
  const res = await apiFetch("GET", `/repos/${repo}/collaborators/${username}/permission`, undefined, { token, apiBase });
  return res.permission === "write" || res.permission === "admin";
}
