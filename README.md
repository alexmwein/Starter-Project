# Quickstart Workspace Repository

This shared repository supports multiple isolated Conductor workspaces. Its root is not a canonical production application, and a workspace's current directory or most recent deployment must not be used to infer the product Alex means.

## How Conductor Uses This Project

Conductor creates each workspace as its own git worktree and branch. The checked-in `.conductor/settings.toml` provides setup, archive, repository-status, and agent guidance shared by those workspaces.

There is intentionally no default app-launch command. Resolve and verify the requested repository, host, and route before opening a browser or deploying anything.

## Retired Surface

- The “OVO Command Center” / “OVO Operating System” static prototype and the Starter-Project GitHub Pages root are retired. Do not open, render, screenshot, test, deploy, restore, or treat them as current.
- “Finance page” or “Finances page” means `https://crm.ovotalent.com/finance` in `alexmwein/ovo-crm-fable`.

## Local Development

Use the task-specific project instructions and development command for the verified target. Do not open the repository root `index.html` merely because it exists.

## Project Structure

- `.conductor/settings.toml` contains the shared Conductor workspace scripts.
- `.context/` is available in Conductor workspaces for gitignored notes and handoff files between agents.

## Learn More

- [Conductor docs](https://conductor.build/docs)
