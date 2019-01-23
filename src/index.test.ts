import * as Octokit from "@octokit/rest";
import {
  fetchRefSha,
  RepoName,
  RepoOwner,
  Sha,
  updateRef,
} from "shared-github-internals/lib/git";
import { createTestContext } from "shared-github-internals/lib/tests/context";
import {
  CommandDirectory,
  createCommitFromLinesAndMessage,
  createGitRepo,
  createRefs,
  DeleteRefs,
  executeGitCommand,
  fetchRefCommits,
  fetchRefCommitsFromSha,
  getRefCommitsFromGitRepo,
  getRefShasFromGitRepo,
  RefsDetails,
} from "shared-github-internals/lib/tests/git";

import { cherryPickCommits } from ".";

const [initial, feature1st, feature2nd, master1st, master2nd] = [
  "initial",
  "feature 1st",
  "feature 2nd",
  "master 1st",
  "master 2nd",
];

let octokit: Octokit;
let owner: RepoName;
let repo: RepoOwner;

beforeAll(() => {
  ({ octokit, owner, repo } = createTestContext());
});

describe("nominal behavior", () => {
  describe.each([
    [
      "same line edited multiple times",
      () => {
        const [initialCommit, master1stCommit] = [
          {
            lines: [initial, initial],
            message: initial,
          },
          {
            lines: [master1st, initial],
            message: master1st,
          },
        ];

        return {
          // Cherry-pick all feature commits except the initial one.
          getCommitsToCherryPickShas: (featureShas: Sha[]) =>
            featureShas.slice(1),
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [
                {
                  lines: [initial, feature1st],
                  message: feature1st,
                },
                {
                  lines: [initial, feature2nd],
                  message: feature2nd,
                },
              ],
              master: [master1stCommit],
            },
          },
        };
      },
    ],
    [
      "skipping commits",
      () => {
        const [initialCommit, master1stCommit] = [
          {
            lines: [initial, initial, initial],
            message: initial,
          },
          {
            lines: [master1st, initial, initial],
            message: master1st,
          },
        ];

        return {
          // Only cherry-pick the last feature commit.
          getCommitsToCherryPickShas: (featureShas: Sha[]) =>
            featureShas.slice(-1),
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [
                {
                  lines: [initial, feature1st, initial],
                  message: feature1st,
                },
                {
                  lines: [initial, initial, feature2nd],
                  message: feature2nd,
                },
              ],
              master: [master1stCommit],
            },
          },
        };
      },
    ],
  ])("%s", (tmp, getProperties) => {
    const { getCommitsToCherryPickShas, initialState } = getProperties();

    let deleteRefs: DeleteRefs;
    let directory: CommandDirectory;
    let refsDetails: RefsDetails;
    let sha: Sha;

    beforeAll(async () => {
      ({ deleteRefs, refsDetails } = await createRefs({
        octokit,
        owner,
        repo,
        state: initialState,
      }));
      sha = await cherryPickCommits({
        commits: getCommitsToCherryPickShas(refsDetails.feature.shas),
        head: refsDetails.master.ref,
        octokit,
        owner,
        repo,
      });
      directory = await createGitRepo(initialState);
      const featureShas = await getRefShasFromGitRepo({
        directory,
        ref: "feature",
      });
      await executeGitCommand({
        args: ["cherry-pick", ...getCommitsToCherryPickShas(featureShas)],
        directory,
        ref: "master",
      });
    }, 25000);

    afterAll(() => deleteRefs());

    test("returned sha is the actual master ref sha", async () => {
      const actualRefSha = await fetchRefSha({
        octokit,
        owner,
        ref: refsDetails.master.ref,
        repo,
      });
      expect(actualRefSha).toBe(sha);
    });

    test("commits on master are the expected ones", async () => {
      const expectedCommits = await getRefCommitsFromGitRepo({
        directory,
        ref: "master",
      });
      expect({ commits: expectedCommits, initialState }).toMatchSnapshot();
      const actualCommits = await fetchRefCommitsFromSha({
        octokit,
        owner,
        repo,
        sha,
      });
      expect(actualCommits).toEqual(expectedCommits);
    });
  });
});

describe("atomicity", () => {
  describe.each([
    [
      "one of the commits cannot be cherry-picked",
      () => {
        const [initialCommit, master1stCommit] = [
          {
            lines: [initial, initial],
            message: initial,
          },
          {
            lines: [master1st, initial],
            message: feature1st,
          },
        ];

        return {
          errorRegex: /Merge conflict/,
          expectedMasterCommits: [initialCommit, master1stCommit],
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [
                {
                  lines: [initial, feature1st],
                  message: feature1st,
                },
                {
                  lines: [feature2nd, feature1st],
                  message: feature2nd,
                },
              ],
              master: [master1stCommit],
            },
          },
        };
      },
    ],
    [
      "the head ref changed",
      () => {
        const [initialCommit, master1stCommit, master2ndCommit] = [
          {
            lines: [initial, initial],
            message: initial,
          },
          {
            lines: [master1st, initial],
            message: master1st,
          },
          {
            lines: [master1st, master2nd],
            message: master2nd,
          },
        ];

        return {
          errorRegex: /Update is not a fast forward/,
          expectedMasterCommits: [
            initialCommit,
            master1stCommit,
            master2ndCommit,
          ],
          getIntercept: (refsDetails: RefsDetails) => async ({
            initialHeadSha,
          }: {
            initialHeadSha: Sha;
          }) => {
            const newCommit = await createCommitFromLinesAndMessage({
              commit: master2ndCommit,
              octokit,
              owner,
              parent: initialHeadSha,
              repo,
            });
            await updateRef({
              force: false,
              octokit,
              owner,
              ref: refsDetails.master.ref,
              repo,
              sha: newCommit,
            });
          },
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [
                {
                  lines: [initial, feature1st],
                  message: feature1st,
                },
              ],
              master: [master1stCommit],
            },
          },
        };
      },
    ],
    [
      "merge commits",
      () => {
        const [initialCommit, feature1stCommit, feature2ndCommit] = [
          {
            lines: [initial, initial],
            message: initial,
          },
          {
            lines: [feature1st, initial],
            message: feature1st,
          },
          {
            lines: [initial, feature2nd],
            message: feature2nd,
          },
        ];

        return {
          async beforeTest(refsDetails: RefsDetails) {
            const {
              data: { sha: mergeCommit },
            } = await octokit.repos.merge({
              base: refsDetails.feature.ref,
              head: refsDetails.other.ref,
              owner,
              repo,
            });
            return [mergeCommit];
          },
          errorRegex: /Commit .+ has 2 parents./,
          expectedMasterCommits: [initialCommit],
          initialState: {
            initialCommit,
            refsCommits: {
              feature: [feature1stCommit],
              master: [],
              other: [feature2ndCommit],
            },
          },
        };
      },
    ],
  ])("%s", (tmp, getProperties) => {
    const {
      beforeTest,
      errorRegex,
      expectedMasterCommits,
      getIntercept,
      initialState,
    } = getProperties();

    let commits: Sha[];
    let deleteRefs: DeleteRefs;
    let refsDetails: RefsDetails;

    beforeAll(async () => {
      ({ deleteRefs, refsDetails } = await createRefs({
        octokit,
        owner,
        repo,
        state: initialState,
      }));
      commits = await (beforeTest
        ? beforeTest(refsDetails)
        : // By default, cherry-pick all feature commits except the initial one.
          Promise.resolve(refsDetails.feature.shas.slice(1)));
    }, 15000);

    afterAll(() => deleteRefs());

    test("whole operation aborted", async () => {
      await expect(
        cherryPickCommits({
          _intercept: getIntercept ? getIntercept(refsDetails) : undefined,
          commits,
          head: refsDetails.master.ref,
          octokit,
          owner,
          repo,
        }),
      ).rejects.toThrow(errorRegex);
      const masterCommits = await fetchRefCommits({
        octokit,
        owner,
        ref: refsDetails.master.ref,
        repo,
      });
      expect(masterCommits).toEqual(expectedMasterCommits);
    }, 15000);
  });
});
