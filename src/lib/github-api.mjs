export async function apiFetch(method, urlPath, body, { token, apiBase }) {
  const res = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export async function upsertComment({ prNumber, body, marker, token, apiBase, repo }) {
  const comments = await apiFetch("GET", `/repos/${repo}/issues/${prNumber}/comments?per_page=100`, undefined, { token, apiBase });
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await apiFetch("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body }, { token, apiBase });
  } else {
    await apiFetch("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body }, { token, apiBase });
  }
}

export async function getCheckRun({ repo, sha, name, token, apiBase }) {
  const existing = await apiFetch(
    "GET",
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`,
    undefined,
    { token, apiBase }
  );
  return existing.check_runs?.find((r) => r.name === name) ?? null;
}

export async function createOrUpdateCheckRun({ repo, sha, name, conclusion, summary, token, apiBase }) {
  const existing = await apiFetch(
    "GET",
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`,
    undefined,
    { token, apiBase }
  );
  const run = existing.check_runs?.find((r) => r.name === name);
  const payload = {
    name,
    head_sha: sha,
    status: "completed",
    conclusion,
    output: { title: name, summary },
  };
  if (run) {
    return apiFetch("PATCH", `/repos/${repo}/check-runs/${run.id}`, payload, { token, apiBase });
  }
  return apiFetch("POST", `/repos/${repo}/check-runs`, payload, { token, apiBase });
}
