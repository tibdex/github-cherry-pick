[![npm version](https://img.shields.io/npm/v/github-cherry-pick.svg)](https://npmjs.org/package/github-cherry-pick)
[![build status](https://img.shields.io/circleci/project/github/tibdex/github-cherry-pick.svg)](https://circleci.com/gh/tibdex/github-cherry-pick)

# Goal

`github-cherry-pick` cherry-picks several commits on a branch using [the low level Git Data operations provided by the GitHub REST API](https://developer.github.com/v3/git/).

See also [`github-rebase`](https://www.npmjs.com/package/github-rebase) if you want to rebase a pull request on its base branch.

# Usage

```javascript
const cherryPickCommits = require("github-cherry-pick");

cherryPickCommits({
  // The SHA list of the commits to cherry-pick.
  // The commits will be cherry-picked in the order they appear in the array.
  // See https://git-scm.com/docs/git-cherry-pick for more details.
  commits: [
    "8b10a7808f06970232dc1b45a77b47d63641c4f1",
    "f393441512c54435819d1cdd8921c0d566911af3",
  ],
  // The name of the branch/reference on top of which the commits will be cherry-picked.
  head: "awesome-feature",
  // An already authenticated instance of https://www.npmjs.com/package/@octokit/rest.
  octokit,
  // The username of the repository owner.
  owner,
  // The name of the repository.
  repo,
}).then(newHeadSha => {
  // Do something.
});
```

`github-cherry-pick` can run on Node.js and in recent browsers.

### Disclaimer

`github-cherry-pick` currently only supports a subset of what `git cherry-pick` offers.

For instance, starting with this Git graph:

```
* 9232f06 (HEAD -> master) D
| * e926f9d (feature) C
| * d216f82 B
|/
* 24dfa35 A
```

Calling `github-cherry-pick` with `['e926f9d']` to only cherry-pick the last commit of the `feature` branch on `master` would also actually apply the changes brought by `d216f82` to `master`.

The [tests file](tests/index.test.js) shows the known use-cases supported by `git cherry-pick` but not by `github-cherry-pick`.
If you have any suggestions for how to support all the situations handled by `git cherry-pick` by only using endpoints of the GitHub REST API, please create an issue or pull request.

## Troubleshooting

`github-cherry-pick` uses [`debug`](https://www.npmjs.com/package/debug) to log helpful information at different steps of the cherry-picking process. To enable these logs, set the `DEBUG` environment variable to `github-cherry-pick`.

# How it Works

The GitHub REST API doesn't provide a direct endpoint for cherry-picking commits on a branch but it does provide lower level Git operations such as:

- merging one branch on top of another one
- creating a commit from a Git tree
- creating/updating/deleting references

It turns out that's all we need to perform a cherry-pick!

## Step by Step

Let's say we have this Git state:

<!--
touch A.txt B.txt C.txt D.txt
git init
git add A.txt
git commit --message A
git checkout -b feature
git add B.txt
git commit --message B
git add C.txt
git commit --message C
git checkout master
git add D.txt
git commit --message D
-->

```
* 9232f06 (HEAD -> master) D
| * e926f9d (feature) C
| * d216f82 B
|/
* 24dfa35 A
```

and we want to cherry-pick `d216f82` and `e926f9d` on the `master` branch.

`github-cherry-pick` would then take the following steps:

1.  Create a `temp` branch from `feature` with [POST /repos/:owner/:repo/git/refs](https://developer.github.com/v3/git/refs/#create-a-reference).
    <!--
    git checkout -b temp
    -->
    ```
    * 9232f06 (HEAD -> temp, master) D
    | * e926f9d (feature) C
    | * d216f82 B
    |/
    * 24dfa35 A
    ```
2.  Merge `d216f82` on `temp` with [POST /repos/:owner/:repo/merges](https://developer.github.com/v3/repos/merging/#perform-a-merge).
    <!--
    git merge d216f82
    -->
    ```
    *   5783c4c (HEAD -> temp) Merge commit 'd216f82' into temp
    |\
    * | 9232f06 (master) D
    | | * e926f9d (feature) C
    | |/
    | * d216f82 B
    |/
    * 24dfa35 A
    ```
3.  Create another commit from `5783c4c` with `9232f06` as the only parent with [POST /repos/:owner/:repo/git/commits](https://developer.github.com/v3/git/commits/#create-a-commit) and update `temp`'s reference to point to this new commit with [PATCH /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#update-a-reference).
    <!--
    git cat-file -p 6cb4aca
    git commit-tree db5a9e1 -p 1d3fb48 -m B
    git update-ref HEAD 1616ba2
    -->
    ```
    * 1616ba2 (HEAD -> temp) B
    * 9232f06 (master) D
    | * e926f9d (feature) C
    | * d216f82 B
    |/
    * 24dfa35 A
    ```
4.  Repeat steps 2. and 3. to cherry-pick `e926f9d` on `temp`.
    ```
    * d82c247 (HEAD -> temp) C
    * 1616ba2 B
    * 9232f06 (master) D
    | * e926f9d (feature) C
    | * d216f82 B
    |/
    * 24dfa35 A
    ```
5.  Set `master`'s reference to the same one than `temp` with [PATCH /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#update-a-reference), making sure it's a fast-forward update.
    <!--
    git checkout feature
    git merge temp --ff-only
    -->
    ```
    * d82c247 (HEAD -> master, temp) C
    * 1616ba2 B
    * 9232f06 D
    | * e926f9d (feature) C
    | * d216f82 B
    |/
    * 24dfa35 A
    ```
6.  Delete the `temp` branch with [DELETE /repos/:owner/:repo/git/refs/:ref](https://developer.github.com/v3/git/refs/#delete-a-reference) and we're done!
    <!--
    git branch --delete temp
    -->
    ```
    * d82c247 (HEAD -> master) C
    * 1616ba2 B
    * 9232f06 D
    | * e926f9d (feature) C
    | * d216f82 B
    |/
    * 24dfa35 A
    ```

## Atomicity

`github-cherry-pick` is atomic.
It will either successfully cherry-pick all the given commits on the specified branch or let the branch untouched if one commit could not be cherry picked or if the branch reference changed while the cherry-picking was happening.
There are [tests](tests/index.test.js) for it.
