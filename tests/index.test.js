// @flow strict

import {
  fetchReferenceSha,
  updateReference,
} from "shared-github-internals/lib/git";
import { createTestContext } from "shared-github-internals/lib/tests/context";
import {
  createCommitFromLinesAndMessage,
  createReferences,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
} from "shared-github-internals/lib/tests/git";

import cherryPick from "../src";

const [initial, feature1st, feature2nd, master1st, master2nd] = [
  "initial",
  "feature 1st",
  "feature 2nd",
  "master 1st",
  "master 2nd",
];

let octokit, owner, repo;

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
          expectedMasterCommits: [
            initialCommit,
            master1stCommit,
            {
              lines: [master1st, feature1st],
              message: feature1st,
            },
            {
              lines: [master1st, feature2nd],
              message: feature2nd,
            },
          ],
          // Cherry-pick all feature commits except the initial one.
          getCommitsToCherryPickShas: featureShas => featureShas.slice(1),
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
          expectedMasterCommits: [
            initialCommit,
            master1stCommit,
            {
              lines: [master1st, initial, feature2nd],
              message: feature2nd,
            },
          ],
          // Only cherry-pick the last feature commit.
          getCommitsToCherryPickShas: featureShas => featureShas.slice(-1),
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
    const {
      expectedMasterCommits,
      getCommitsToCherryPickShas,
      initialState,
    } = getProperties();

    let deleteReferences, refsDetails, sha;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: initialState,
      }));
      sha = await cherryPick({
        commits: getCommitsToCherryPickShas(refsDetails.feature.shas),
        head: refsDetails.master.ref,
        octokit,
        owner,
        repo,
      });
    }, 25000);

    afterAll(() => deleteReferences());

    test("returned sha is the actual master ref sha", async () => {
      const actualRefSha = await fetchReferenceSha({
        octokit,
        owner,
        ref: refsDetails.master.ref,
        repo,
      });
      expect(actualRefSha).toBe(sha);
    });

    test("commits on master are the expected ones", async () => {
      const actualCommits = await fetchReferenceCommitsFromSha({
        octokit,
        owner,
        repo,
        sha,
      });
      expect(actualCommits).toEqual(expectedMasterCommits);
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
          errorRegex: /Merge conflict/u,
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
      "the head reference changed",
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
          errorRegex: /Update is not a fast forward/u,
          expectedMasterCommits: [
            initialCommit,
            master1stCommit,
            master2ndCommit,
          ],
          getIntercept: refsDetails => async ({ initialHeadSha }) => {
            const newCommit = await createCommitFromLinesAndMessage({
              commit: master2ndCommit,
              octokit,
              owner,
              parent: initialHeadSha,
              repo,
            });
            await updateReference({
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
  ])("%s", (tmp, getProperties) => {
    const {
      errorRegex,
      expectedMasterCommits,
      getIntercept,
      initialState,
    } = getProperties();

    let deleteReferences, refsDetails;

    beforeAll(async () => {
      ({ deleteReferences, refsDetails } = await createReferences({
        octokit,
        owner,
        repo,
        state: initialState,
      }));
    }, 15000);

    afterAll(() => deleteReferences());

    test(
      "whole operation aborted",
      async () => {
        await expect(
          cherryPick({
            // eslint-disable-next-line no-undefined
            _intercept: getIntercept ? getIntercept(refsDetails) : undefined,
            // Cherry-pick all feature commits except the initial one.
            commits: refsDetails.feature.shas.slice(1),
            head: refsDetails.master.ref,
            octokit,
            owner,
            repo,
          })
        ).rejects.toThrow(errorRegex);
        const masterCommits = await fetchReferenceCommits({
          octokit,
          owner,
          ref: refsDetails.master.ref,
          repo,
        });
        expect(masterCommits).toEqual(expectedMasterCommits);
      },
      15000
    );
  });
});
