// @flow strict

import type { Github } from "@octokit/rest";
import {
  type Reference,
  type RepoName,
  type RepoOwner,
  type Sha,
  fetchReferenceSha,
  updateReference,
  withTemporaryReference,
} from "shared-github-internals/lib/git";
import createDebug from "debug";

import { name as packageName } from "../package";

const createCommit = async ({
  author,
  committer,
  message,
  octokit,
  owner,
  parent,
  repo,
  tree,
}) => {
  const {
    data: { sha },
  } = await octokit.gitdata.createCommit({
    author,
    committer,
    message,
    owner,
    parents: [parent],
    repo,
    // No PGP signature support for now.
    // See https://developer.github.com/v3/git/commits/#create-a-commit.
    tree,
  });
  return sha;
};

const merge = async ({ base, commit, octokit, owner, repo }) => {
  const {
    data: {
      commit: {
        tree: { sha: tree },
      },
    },
  } = await octokit.repos.merge({
    base,
    head: commit,
    owner,
    repo,
  });
  return tree;
};

const retrieveCommitDetails = async ({ commit, octokit, owner, repo }) => {
  const {
    data: {
      author,
      committer,
      message,
      parents: [{ sha: parent }],
    },
  } = await octokit.gitdata.getCommit({
    commit_sha: commit,
    owner,
    repo,
  });
  return { author, committer, message, parent };
};

const createSiblingCommit = async ({
  commit,
  head: { author, committer, ref, tree },
  octokit,
  owner,
  parent,
  repo,
}) => {
  const sha = await createCommit({
    author,
    committer,
    message: `Sibling of ${commit}`,
    octokit,
    owner,
    parent,
    repo,
    tree,
  });
  await updateReference({
    force: true,
    octokit,
    owner,
    ref,
    repo,
    sha,
  });
};

const cherryPickCommit = async ({
  commit,
  debug,
  head: { ref, sha, tree },
  octokit,
  owner,
  repo,
}) => {
  const { author, committer, message, parent } = await retrieveCommitDetails({
    commit,
    octokit,
    owner,
    repo,
  });
  debug("creating sibling commit");
  await createSiblingCommit({
    commit,
    head: { author, committer, ref, tree },
    octokit,
    owner,
    parent,
    repo,
  });
  debug("merging");
  const newHeadTree = await merge({
    base: ref,
    commit,
    octokit,
    owner,
    repo,
  });
  debug("creating commit with different tree", newHeadTree);
  const newHeadSha = await createCommit({
    author,
    committer,
    message,
    octokit,
    owner,
    parent: sha,
    repo,
    tree: newHeadTree,
  });
  debug("updating reference", newHeadSha);
  await updateReference({
    // Overwrite the merge commit and its parent on the branch by a single commit.
    // The result will be equivalent to what would have happened with a fast-forward merge.
    force: true,
    octokit,
    owner,
    ref,
    repo,
    sha: newHeadSha,
  });
  return {
    sha: newHeadSha,
    tree: newHeadTree,
  };
};

const cherryPickCommitsOnReference = async ({
  commits,
  debug,
  initialHeadSha,
  octokit,
  owner,
  ref,
  repo,
}) => {
  const {
    data: {
      tree: { sha: initialHeadTree },
    },
  } = await octokit.gitdata.getCommit({
    commit_sha: initialHeadSha,
    owner,
    repo,
  });

  const { sha: newHeadSha } = await commits.reduce(
    async (previousCherryPick, commit) => {
      const { sha, tree } = await previousCherryPick;
      debug("cherry-picking", { commit, ref, sha });
      return cherryPickCommit({
        commit,
        debug,
        head: { ref, sha, tree },
        octokit,
        owner,
        repo,
      });
    },
    Promise.resolve({
      sha: initialHeadSha,
      tree: initialHeadTree,
    })
  );

  return newHeadSha;
};

// eslint-disable-next-line max-lines-per-function
const cherryPickCommits = async ({
  // Should only be used in tests.
  _intercept = () => Promise.resolve(),
  commits,
  head,
  octokit,
  owner,
  repo,
}: {
  _intercept?: ({ initialHeadSha: Sha }) => Promise<void>,
  commits: Array<Sha>,
  head: Reference,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<Sha> => {
  const debug = createDebug(packageName);
  debug("starting", { commits, head, owner, repo });
  const initialHeadSha = await fetchReferenceSha({
    octokit,
    owner,
    ref: head,
    repo,
  });
  await _intercept({ initialHeadSha });
  return withTemporaryReference({
    action: async temporaryRef => {
      debug({ temporaryRef });
      const newSha = await cherryPickCommitsOnReference({
        commits,
        debug,
        initialHeadSha,
        octokit,
        owner,
        ref: temporaryRef,
        repo,
      });
      debug("updating reference with new SHA", newSha);
      await updateReference({
        // Make sure it's a fast-forward update.
        force: false,
        octokit,
        owner,
        ref: head,
        repo,
        sha: newSha,
      });
      debug("reference updated");
      return newSha;
    },
    octokit,
    owner,
    ref: `cherry-pick-${head}`,
    repo,
    sha: initialHeadSha,
  });
};

export default cherryPickCommits;
