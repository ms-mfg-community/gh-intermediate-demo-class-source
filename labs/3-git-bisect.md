# Lab 3: Git Bisect

In this lab, you're going to use `git bisect` to locate a commit that introduced
a bug in your game's unit tests.

## Scenario

It looks like your unit tests aren't passing! You're not sure when the bug was
introduced, but you know it wasn't there when you first created the game.

## Task 1: Setup `git bisect`

1. Start the `git bisect` process

   ```bash
   git bisect start
   ```

1. Indicate a commit where you know the code contains the change you're looking
   for

   Omitting the commit hash will tell Git that the current commit is bad.

   ```bash
   git bisect bad
   ```

1. Locate a commit where the code change is not present

   Your repository was set up with a `lab-baseline` tag marking the last release
   known to pass its tests, so that is a commit you know is good.

   ```bash
   git show --no-patch --oneline lab-baseline
   ```

   > **Why not simply pick the oldest commit?** `git bisect` assumes the change
   > you are hunting for appears exactly once. This project's history is long
   > and the same assertion was disabled and re-enabled during its development,
   > so starting from the very first commit can lead `git bisect` to an older,
   > unrelated commit — and it will do so without warning. Marking a known-good
   > release as the starting point is both the safer habit and the one you would
   > use on a real project.

1. Indicate a commit where you know the code does not contain the change you're
   looking for

   ```bash
   git bisect good lab-baseline
   ```

## Task 2: Locate the Commit

The git bisect command will check out the middle commit between the good and bad
ones.

1. Check if the code change is present in the file

   ```bash
   grep -w "expect(true).toBe(false)" __tests__/keyboard_input_manager.test.ts
   ```

   If the code change is present, the `grep` command will output the matching
   line(s).

   ```bash
   # Found
   $ grep -w "expect(true).toBe(false)" __tests__/keyboard_input_manager.test.ts
    expect(true).toBe(false);

   # Not found
   $ grep -w "expect(true).toBe(false)" __tests__/keyboard_input_manager.test.ts

   ```

1. If the change is present, tell `git bisect` that the current commit is bad

   ```bash
   git bisect bad
   ```

1. If the change is not present, tell `git bisect` that the current commit is
   good

   ```bash
   git bisect good
   ```

   Git will locate and checkout the new **mid** point.

1. Repeat the previous steps until Git locates the first commit with the
   specified change.

   When the process is complete, Git will output the commit that introduced the
   change. The commit hash below is an example; yours will differ.

   ```bash
   3df75e71621bf183439ff58a9c2bb89c30556460 is the first bad commit
   commit 3df75e71621bf183439ff58a9c2bb89c30556460 (HEAD)
   Author: Course Fixture Builder <fixture@example.invalid>
   Date:   Wed Jan 1 00:04:00 2025 +0000

       Disable broken test

    __tests__/keyboard_input_manager.test.ts | 3 ++-
    1 file changed, 2 insertions(+), 1 deletion(-)
   ```

## Task 3: Finish `git bisect`

1. Finish the `git bisect` process

   ```bash
   git bisect reset
   ```

   This will return you to the `HEAD` commit.

## Task 4: Fix the Broken Test

1. Create a new feature branch

   ```bash
   git checkout -b fix/unit-test
   ```

1. Open
   [`__tests__/keyboard_input_manager.test.ts`](../__tests__/keyboard_input_manager.test.ts)
1. Locate the comment `// Lab 3: Git Bisect`
1. Add the following code below the comment

   Make sure to replace `expect(true).toBe(false)` with the correct test code.

   ```typescript
   // Lab 3: Git Bisect
   const listen = jest
     .spyOn(KeyboardInputManager, 'listen')
     .mockImplementation(() => {})

   new KeyboardInputManager()

   expect(KeyboardInputManager.events).toMatchObject({})
   expect(listen).toHaveBeenCalledTimes(1)
   ```

1. Save the file
1. (Optional) Run the tests

   If you have [Node.js v22+](https://nodejs.org) installed, you can run the
   tests with the following commands:

   ```bash
   npm i && npm test
   ```

## Task 5: Commit your Changes

Now that you've fixed the broken test, you should commit your changes to your
feature branch.

1. Open the terminal or command prompt
1. Add your changes to the staging area

   ```bash
   git add __tests__/keyboard_input_manager.test.ts
   ```

1. Commit your changes

   ```bash
   git commit -m "Fix broken test"
   ```

## Task 6: Switch to the `main` Branch

Now that you've added the feature, you should switch back to the `main` branch
so you can start working on something new!

1. Checkout the `main` branch

   ```bash
   git checkout main
   ```

## Task 7: Merge the `fix/unit-test` Branch

Now that you're on the `main` branch, you should merge the `fix/unit-test`
branch into the `main` branch. That way, when your changes are pushed, the unit
tests will pass the next time the run as part of the continuous integration
process.

1. Merge the `fix/unit-test` branch into the `main` branch

   ```bash
   git merge fix/unit-test
   ```

1. Push your changes to GitHub

   ```bash
   git push
   ```

## Need Help?

If you're having trouble with any of the steps, you can ask for help in the
meeting chat.

The code changes for this lab can be found in the `solutions` directory.

- Copy the contents of
  [`solutions/3-git-bisect/keyboard_input_manager.test.ts`](../solutions/3-git-bisect/keyboard_input_manager.test.ts)
  and replace the contents of
  [`__tests__/keyboard_input_manager.test.ts`](../__tests__/keyboard_input_manager.test.ts)
