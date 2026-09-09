# Lab 4: Interactive Rebase

In this lab, you're going to use `git rebase --interactive` to take an outdated
feature branch and move it to the latest commit on `main`.

## Scenario

The product team has told us that a work-in-progress feature needs to be
reprioritized. This feature was partially completed, and then put on hold. The
branch is still present, so let's bring it back up to date and deliver that
feature.

Commit IDs in the examples below are illustrative; your commit IDs will differ.

## Task 1: Checkout the Feature Branch

1. Checkout the feature branch

   ```bash
   git checkout feature/animate-score
   ```

1. Verify the feature branch is behind `main`

   ```bash
   git log --oneline --graph --all
   ```

   In the graph output, you should see that the `feature/animate-score` branch
   was created from an earlier commit on `main`.

   ```plain
   * 9b41d7c (main, origin/main) Note the class baseline in the README
   * 4c8e2a1 Tidy the game rules markup
   * 6d17f95 Disable broken test
   * 82ac3e0 Document the game controls
   | * d2b828f (HEAD -> feature/animate-score) Revert change
   | * f723e2f Remove comment
   | * a4f1c35 Update scoreboard size
   | * 0f3cb0b Animate score update
   |/
   * 35710de Add watch script
   * 6181c9c Remove maintenance tooling tests
   ```

   > Because `--all` shows every branch, the four `feature/start-tiles-*` and
   > `feature/tile-value-*` branches used in Lab 8 also appear. They are not
   > part of this lab; ignore them for now.

## Task 2: Rebase the Feature Branch

1. Interactively rebase the feature branch onto `main`

   ```bash
   git rebase --interactive main
   ```

   In the editor that opens, you should see a list of commits. The first commit
   is the one that the branch was created from, and the last commit is the most
   recent commit on `main`.

   ```plain
   pick 0f3cb0b Animate score update
   pick a4f1c35 Update scoreboard size
   pick f723e2f Remove comment
   pick d2b828f Revert change
   ```

   In this exercise, we want to combine all the commits on the
   `feature/animate-score` branch into a single commit. This will make it easier
   to follow the changes in the commit history.

1. Update the commit list to squash all the commits into a single commit and
   modify the commit message.

   ```plain
   reword 0f3cb0b Animate score update
   squash a4f1c35 Update scoreboard size
   squash f723e2f Remove comment
   squash d2b828f Revert change
   ```

   Save and close the editor.

   > **Hint:** If you are using VI or VIM, you can save and close the editor by
   > pressing `ESC`, typing `:wq`, and pressing `Enter`.

1. You will be prompted to modify the message for the reworded commit. The
   message will be pre-filled with the original commit message. If you want to
   keep the original message, simply save and close the file. Otherwise, modify
   the message as needed and save and close the file.

## Task 3: Verify the Feature Branch

1. Verify that the feature branch is now up to date with `main`

   ```bash
   git log --oneline --graph --all
   ```

   In the graph output, you should see that the `feature/animate-score` branch
   is now based on the most recent commit on `main`.

   ```plain
   * 0f3cb0b (HEAD -> feature/animate-score) Animate score update
   * 9b41d7c (main, origin/main) Note the class baseline in the README
   * 4c8e2a1 Tidy the game rules markup
   * 6d17f95 Disable broken test
   * 82ac3e0 Document the game controls
   * 35710de Add watch script
   ```

   > In the example above, the topmost commit message should be set to whatever
   > value you provided in the previous steps.

## Task 4: Merge the `feature/animate-score` Branch

Now that you've rebased the feature branch, you should switch back to the `main`
branch so you can merge your changes!

1. Checkout the `main` branch

   ```bash
   git checkout main
   ```

1. Merge the `feature/animate-score` branch into the `main` branch

   ```bash
   git merge feature/animate-score
   ```

1. Push your changes to GitHub

   ```bash
   git push
   ```

1. Navigate to your repository on GitHub.com
1. Click the **Actions** tab
1. Click the running **Deploy to GitHub Pages** workflow
1. Wait for the workflow run to complete
1. Click the **Code** tab
1. Click the link to your game
1. Verify the game score updates are animated

## Need Help?

If you're having trouble with any of the steps, you can ask for help in the
meeting chat.

The code changes for this lab can be found in the `solutions` directory.

- Copy the contents of
  [`solutions/4-interactive-rebase/html_actuator.ts`](../solutions/4-interactive-rebase/html_actuator.ts)
  and replace the contents of [`src/html_actuator.ts`](../src/html_actuator.ts)
