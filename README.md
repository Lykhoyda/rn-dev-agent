# rn-dev-agent

A Claude Code plugin that turns Claude into a React Native development partner. It explores your codebase, designs architecture, implements features, then **verifies everything live on the simulator** — reading the component tree, store state, and navigation stack through Chrome DevTools Protocol.

## Quick Start

From inside Claude Code, run these commands:

```bash
# 1. Add the marketplace
/plugin marketplace add Lykhoyda/react-native-dev-claude-plugin

# 2. Install the plugin
/plugin install rn-dev-agent@Lykhoyda-react-native-dev-claude-plugin

# 3. Reload plugins to activate
/reload-plugins
```

Then navigate to your React Native project and start building:

```bash
cd /path/to/your-rn-app
/rn-dev-agent:rn-feature-dev Add a user profile screen with avatar upload
```

## Documentation

Full documentation, tool reference, and troubleshooting guide are in [`plugin/README.md`](plugin/README.md).

## Repository Structure

```
├── plugin/          # Plugin source (what gets installed)
│   ├── .claude-plugin/plugin.json
│   ├── skills/      # 4 skills (device control, testing, debugging, best practices)
│   ├── agents/      # 5 agents (tester, debugger, explorer, architect, reviewer)
│   ├── commands/    # 5 commands (feature-dev, test, debug, build, check-env)
│   ├── hooks/       # Session + post-edit health check hooks
│   └── scripts/     # CDP bridge MCP server (TypeScript)
├── test-app/        # Expo test fixture app (not installed with plugin)
├── packages/        # Runtime packages (dev bridge)
└── docs/            # Roadmap, decisions, proof artifacts
```

## License

MIT
