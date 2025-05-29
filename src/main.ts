import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

// Получаем переменные
const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const CUSTOM_API_KEY = core.getInput("CUSTOM_API_KEY");
const CUSTOM_API_URL = "https://1vts9b3q5f9dgg-8000.proxy.runpod.net/v1/chat/completions";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(owner: string, repo: string, pull_number: number): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error
  return response.data;
}

async function analyzeCode(parsedDiff: File[], prDetails: PRDetails) {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }

  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes.map(c => `${c.ln || c.ln2} ${c.content}`).join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{ lineNumber: string; reviewComment: string }>> {
  try {
    const response = await fetch(CUSTOM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CUSTOM_API_KEY}`,
      },
      body: JSON.stringify({
        model: "Mistral-Small-3.1-24B-Instruct-2503",
        messages: [
          { role: "system", content: "You are a code review assistant." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - ${await response.text()}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    return parsed.reviews ?? [];
  } catch (err) {
    console.error("AI request failed:", err);
    return [];
  }
}

function createComment(file: File, chunk: Chunk, aiResponses: Array<{ lineNumber: string; reviewComment: string }>) {
  return aiResponses.map((resp) => ({
    body: resp.reviewComment,
    path: file.to!,
    line: Number(resp.lineNumber),
  }));
}

async function createReviewComment(owner: string, repo: string, pull_number: number, comments: Array<{ body: string; path: string; line: number }>) {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));

  let diff: string | null = null;
  if (eventData.action === "opened") {
    diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
  } else if (eventData.action === "synchronize") {
    const response = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: eventData.before,
      head: eventData.after,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const excludePatterns = core.getInput("exclude").split(",").map((s) => s.trim());
  const filteredDiff = parsedDiff.filter((file) => !excludePatterns.some((p) => minimatch(file.to ?? "", p)));

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
  }
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
