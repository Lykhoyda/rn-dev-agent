import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://lykhoyda.github.io',
  base: '/rn-dev-agent',
  integrations: [
    starlight({
      title: 'rn-dev-agent',
      description: 'Claude Code plugin for React Native — 38 MCP tools, 5 agents, 12 commands.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Lykhoyda/rn-dev-agent' },
      ],
      editLink: {
        baseUrl: 'https://github.com/Lykhoyda/rn-dev-agent/edit/main/docs-site/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Getting Started', slug: 'getting-started' },
        { label: 'Architecture', slug: 'architecture' },
        {
          label: 'Commands',
          items: [
            { label: 'Overview', slug: 'commands' },
            {
              label: 'Core',
              items: [
                { label: 'rn-feature-dev', slug: 'commands/rn-feature-dev' },
                { label: 'test-feature', slug: 'commands/test-feature' },
                { label: 'build-and-test', slug: 'commands/build-and-test' },
                { label: 'debug-screen', slug: 'commands/debug-screen' },
                { label: 'check-env', slug: 'commands/check-env' },
              ],
            },
            {
              label: 'Proof & Testing',
              items: [
                { label: 'proof-capture', slug: 'commands/proof-capture' },
                { label: 'nav-graph', slug: 'commands/nav-graph' },
              ],
            },
            {
              label: 'Experience Engine',
              items: [
                { label: 'rn-agent-health', slug: 'commands/rn-agent-health' },
                { label: 'rn-agent-compact', slug: 'commands/rn-agent-compact' },
                { label: 'rn-agent-export', slug: 'commands/rn-agent-export' },
                { label: 'rn-agent-import', slug: 'commands/rn-agent-import' },
              ],
            },
            { label: 'send-feedback', slug: 'commands/send-feedback' },
          ],
        },
        {
          label: 'MCP Tools',
          items: [
            { label: 'Overview', slug: 'tools' },
            {
              label: 'CDP Tools (19)',
              collapsed: false,
              autogenerate: { directory: 'tools/cdp' },
            },
            {
              label: 'Device Tools (14)',
              collapsed: true,
              autogenerate: { directory: 'tools/device' },
            },
            {
              label: 'Testing Tools (5)',
              collapsed: true,
              autogenerate: { directory: 'tools/testing' },
            },
          ],
        },
        {
          label: 'Agents',
          items: [
            { label: 'Overview', slug: 'agents' },
            { label: 'rn-tester', slug: 'agents/rn-tester' },
            { label: 'rn-debugger', slug: 'agents/rn-debugger' },
            { label: 'rn-code-explorer', slug: 'agents/rn-code-explorer' },
            { label: 'rn-code-architect', slug: 'agents/rn-code-architect' },
            { label: 'rn-code-reviewer', slug: 'agents/rn-code-reviewer' },
          ],
        },
        {
          label: 'Skills',
          items: [
            { label: 'Overview', slug: 'skills' },
            { label: 'Device Control', slug: 'skills/rn-device-control' },
            { label: 'Testing', slug: 'skills/rn-testing' },
            { label: 'Debugging', slug: 'skills/rn-debugging' },
            { label: 'Best Practices', slug: 'skills/rn-best-practices' },
          ],
        },
        {
          label: 'Best Practices',
          items: [
            { label: 'Rule Index', slug: 'best-practices' },
            {
              label: 'Rules',
              collapsed: true,
              autogenerate: { directory: 'best-practices/rules' },
            },
          ],
        },
        { label: 'Benchmarks', slug: 'benchmarks' },
        { label: 'Troubleshooting', slug: 'troubleshooting' },
        { label: 'Changelog', slug: 'changelog' },
      ],
    }),
  ],
});
