# Lab 0: Clone the Repository

In this lab, you're going to make a local copy of the repository you'll use for
the rest of the training. Every other lab starts from the copy you make here.

You can complete this lab on your own, before the first session. Set aside about
fifteen minutes. Nobody needs to watch you do it, and finishing it early is the
point: a problem found now is a five minute email, and the same problem found at
the start of session one costs the whole room.

## Scenario

A repository has been provisioned for you in the organization used for this
class. It's private, it already contains the game's full commit history, and
it's the only copy you should work in. You were sent its URL along with this
lab.

Before the first session you need two things: that repository on your own
machine, and Git able to prove who you are when it talks to GitHub. From Lab 1
onwards you'll be pushing your work back, so a clone that you can't push from
isn't finished.

There are two ways to authenticate, and your organization decides which one is
open to you. **Task 3** sets up a fine-grained personal access token and clones
over HTTPS. **Task 4** sets up an SSH key instead. Do one of them, not both. If
you don't know which applies to you, start with Task 3 — Task 4 is the fallback
for when your organization restricts tokens.

## Task 1: Check Your Tools

1. Open a terminal

   On Windows, use **Git Bash**, which is installed with Git. On macOS or Linux,
   use your usual terminal.

1. Verify Git is installed

   ```bash
   git --version
   ```

   You should see a version number, `2.30` or newer. If you see
   `command not found` or `'git' is not recognized`, install Git from
   [git-scm.com](https://git-scm.com/downloads), then close the terminal and
   open a new one.

1. Check whether Git knows who you are

   ```bash
   git config --get user.name
   git config --get user.email
   ```

1. If either command printed nothing, set it

   Use your own name and the email address on your GitHub account.

   ```bash
   git config --global user.name "Mona Octocat"
   git config --global user.email "mona@github.com"
   ```

1. Read the values back

   ```bash
   git config --get user.name
   ```

   Don't skip this. Type the quotes as plain straight quotes — if your terminal
   or a copy-paste has turned them into curly quotes, the command above still
   succeeds silently and stores the wrong value, and every commit you make for
   the rest of the course is misattributed.

## Task 2: Confirm You Have Access

Do this before you create any credentials. If your account can't see the
repository in a browser, no token or key will fix it, and that's something your
instructor has to sort out.

1. In your browser, sign in to GitHub

   If your organization uses single sign-on, sign in the way you normally sign
   in to work systems, not with a personal account.

1. Open the repository URL you were sent
1. Confirm the page loads and shows the game's files

   If you get a **404**, your account hasn't been granted access yet. Stop here
   and report it — see [Need Help?](#need-help) below.

1. Note the repository's owner and name from the URL

   ```plain
   https://github.com/<organization>/<repository>
   ```

   You'll substitute those two values into the commands below.

## Task 3: Clone over HTTPS with a Personal Access Token

Skip to Task 4 if you're using SSH.

Git uses a personal access token in place of a password when you work over
HTTPS. A token is better than a password because you control exactly what it can
reach, you can give it an expiry date, and you can revoke it without changing
anything else about your account.

1. Navigate to GitHub.com and select your profile photo, then **Settings**
1. In the left sidebar, click **Developer settings**
1. Expand **Personal access tokens**, then click **Fine-grained tokens**
1. Click **Generate new token**
1. In the **Token name** field, enter a name you'll recognize later, e.g.
   `github-intermediate-training`
1. Set **Expiration** to a date shortly after the course ends
1. Set **Resource owner** to the **organization** that owns your class
   repository

   This is the step people get wrong. A token whose resource owner is your own
   account cannot reach a repository owned by an organization, however many
   permissions you give it.

1. Under **Repository access**, select **Only select repositories**, then choose
   your class repository
1. Under **Permissions**, expand **Repository permissions** and set:
   - **Contents:** Read and write
   - **Pull requests:** Read and write
   - **Metadata:** Read-only (this is selected for you and can't be removed)

1. Click **Generate token**
1. Copy the token immediately and paste it somewhere safe

   You can't view it again after you leave the page. Treat it like a password.

1. Check whether the token is active or pending

   If your organization requires an owner to approve token access — which is
   GitHub's default for organization-owned resources — your token is listed as
   **Pending** and will not work until it's approved. Ask for approval now
   rather than on the morning of the session. If approval isn't going to happen,
   use Task 4 instead.

1. In your terminal, change to the directory you want the project in

   ```bash
   cd ~
   mkdir -p training
   cd training
   ```

1. Clone the repository

   ```bash
   git clone https://github.com/<organization>/<repository>.git
   ```

1. When prompted, enter your credentials

   At **Username**, enter your GitHub username. At **Password**, paste your
   personal access token — not your account password. Nothing appears on screen
   as you paste it; that's expected.

   Depending on your machine, a browser window or a credential manager dialog
   may open instead of a terminal prompt. Either is fine.

1. Continue to Task 5

## Task 4: Clone over SSH with an SSH Key

Do this task only if you didn't complete Task 3. An SSH key is the alternative
when your organization restricts personal access tokens. Git authenticates with
a key pair instead of a token, and you aren't prompted for credentials on every
clone or push.

1. Check whether you already have a key

   ```bash
   ls -al ~/.ssh
   ```

   If you see `id_ed25519` and `id_ed25519.pub`, you already have a key pair and
   can skip the next step.

1. Generate a new key

   Use the email address on your GitHub account.

   ```bash
   ssh-keygen -t ed25519 -C "mona@github.com"
   ```

   Press **Enter** to accept the default file location. Set a passphrase when
   prompted.

1. Start the SSH agent and add your key

   ```bash
   eval "$(ssh-agent -s)"
   ssh-add ~/.ssh/id_ed25519
   ```

1. Display your **public** key and copy it

   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```

   Copy the whole line, beginning `ssh-ed25519`. Only ever share this `.pub`
   file. The matching file without the extension is your private key and must
   not leave your machine.

1. Navigate to GitHub.com and select your profile photo, then **Settings**
1. In the left sidebar, click **SSH and GPG keys**
1. Click **New SSH key**
1. Give the key a title, leave **Key type** as **Authentication Key**, paste the
   public key into the **Key** field, and click **Add SSH key**
1. If your organization uses SAML single sign-on, authorize the key

   Find the key in the list, click **Configure SSO**, and authorize it for the
   organization that owns your class repository. Without this the key
   authenticates you to GitHub but still can't reach the organization's
   repositories.

1. Test the connection

   ```bash
   ssh -T git@github.com
   ```

   The first time, you'll be asked to confirm GitHub's fingerprint — type `yes`.
   Success looks like this:

   ```plain
   Hi <username>! You've successfully authenticated, but GitHub does not
   provide shell access.
   ```

   That message is the result you want. It's telling you the key works; GitHub
   simply doesn't give you a shell.

1. In your terminal, change to the directory you want the project in

   ```bash
   cd ~
   mkdir -p training
   cd training
   ```

1. Clone the repository

   Note the SSH form of the URL — a colon after `github.com`, not a slash.

   ```bash
   git clone git@github.com:<organization>/<repository>.git
   ```

   You won't be asked for a username or a password.

## Task 5: Verify the Clone

1. Change into the new directory

   ```bash
   cd <repository>
   ```

1. Confirm you have the project's history

   ```bash
   git log --oneline -5
   ```

   You should see several commits. If you see only one, you have a copy made
   from a template rather than the repository provisioned for this class, and
   several later labs won't work. Report it.

1. Confirm the state of your working copy

   ```bash
   git status
   ```

   ```plain
   On branch main
   Your branch is up to date with 'origin/main'.

   nothing to commit, working tree clean
   ```

1. Open [`index.html`](../index.html) in your web browser

   From the repository directory:

   ```bash
   # Windows (Git Bash)
   start index.html

   # macOS
   open index.html

   # Linux
   xdg-open index.html
   ```

   You can also just double-click the file, or drag it onto a browser window.

1. Verify the page renders

   You should see the **2048** title, two score boxes, the text "Join the
   numbers and get to the 2048 tile!", a **New Game** button, and an empty four
   by four grid.

1. Expect the grid to be empty

   **No numbered tiles appear, and the arrow keys do nothing. That is correct,
   and your clone is fine.** The game's JavaScript is built from the TypeScript
   in `src/` into `dist/application.js`, and build output isn't stored in the
   repository — GitHub Actions builds it when the site is published. What you're
   checking here is that the page, its stylesheet and the grid load from your
   own disk.

   If you have Node.js v22 or newer installed and want to see the game actually
   play, you can build it yourself. This is entirely optional and no lab
   requires it.

   ```bash
   npm install
   npm run package
   ```

   Then refresh the page in your browser.

## Task 6: Confirm You're Ready

1. Check that all four of these are true
   - `git --version` prints a version number
   - `git config --get user.name` prints your name
   - `git log --oneline -5` inside the clone prints several commits
   - `index.html` opens in your browser and shows the 2048 page and the empty
     grid

1. Leave the clone where it is

   Every later lab starts from this directory. Don't delete it between sessions.

1. Report the result

   Reply to whoever sent you this lab and confirm that setup worked. If it
   didn't, tell them which task you reached and paste the exact error message —
   that's usually enough to fix it before the session starts.

## Need Help?

If you're having trouble with any of the steps, you can ask for help in the
meeting chat. If you're working through this before the first session, reply to
the person who sent you the repository URL instead.

Most failures are one of the following.

| What you see                                                            | What it means and what to do                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git: command not found`, or `'git' is not recognized`                  | Git isn't installed, or your terminal was open before it was installed. Install from [git-scm.com](https://git-scm.com/downloads), then close the terminal and open a new one                                                                                                                                                                                                                                         |
| **404** on the repository page while signed in                          | Your account hasn't been granted access, or you're signed in with the wrong account. Nothing local will fix this — report it                                                                                                                                                                                                                                                                                          |
| `remote: Repository not found` over HTTPS                               | The token can't see the repository. Confirm its **Resource owner** is the organization, that the repository is listed under **Repository access**, and that the token isn't **Pending** approval                                                                                                                                                                                                                      |
| `remote: Invalid username or password`, or an endless credential prompt | You entered your account password instead of the token, or an old credential is cached. On Windows, open **Credential Manager → Windows Credentials** and remove the `git:https://github.com` entry. On macOS, open **Keychain Access** and delete the `github.com` internet password. Then clone again                                                                                                               |
| Your token is listed as **Pending**                                     | An organization owner has to approve it. Ask now, or switch to an SSH key (Task 4)                                                                                                                                                                                                                                                                                                                                    |
| `Permission denied (publickey)`                                         | The key isn't loaded, isn't registered on GitHub, or isn't authorized for the organization. Re-run `ssh-add ~/.ssh/id_ed25519`, then `ssh -T git@github.com`                                                                                                                                                                                                                                                          |
| `Could not resolve host: github.com`, or the clone hangs                | Usually a corporate proxy. Set it, replacing the address with the one your IT team gives you: `git config --global http.proxy http://PROXY_SERVER_ADDRESS:8080`. If the proxy needs credentials, use `http://USERNAME@PROXY_SERVER_ADDRESS:8080` and let Git prompt for the password — never put a password in the command. Remove the setting at the end of the course with `git config --global --unset http.proxy` |
| `SSL certificate problem: unable to get local issuer certificate`       | Your network inspects TLS traffic and Git doesn't trust its certificate. Ask your IT team for the corporate CA bundle and point Git at it with `git config --global http.sslCAInfo <path>`. Don't turn certificate verification off                                                                                                                                                                                   |
| The page opens but is unstyled, or the grid is missing                  | You opened the wrong file, or you're not in the repository root. Run `git status` and confirm you're inside the clone, then open `index.html` from that directory                                                                                                                                                                                                                                                     |
| The grid is there but no tiles move                                     | Expected. See Task 5, step 6                                                                                                                                                                                                                                                                                                                                                                                          |
