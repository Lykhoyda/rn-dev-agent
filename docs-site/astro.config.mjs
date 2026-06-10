import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://lykhoyda.github.io',
  base: '/rn-dev-agent',
  integrations: [
    starlight({
      title: 'rn-dev-agent',
      description: 'Claude Code plugin for React Native development — 74 MCP tools, 5 agents, 17 commands. Explore, build, verify, and test features live on iOS Simulator and Android Emulator via Chrome DevTools Protocol.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Lykhoyda/rn-dev-agent' },
      ],
      head: [
        { tag: 'meta', attrs: { name: 'keywords', content: 'react native, claude code, plugin, mcp, chrome devtools protocol, expo, ios simulator, android emulator, ai testing, mobile development' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://lykhoyda.github.io/rn-dev-agent/og-image.png' } },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'link', attrs: { rel: 'canonical', href: 'https://lykhoyda.github.io/rn-dev-agent/' } },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'rn-dev-agent',
            description: 'Claude Code plugin for React Native development with 74 MCP tools for live app verification via Chrome DevTools Protocol.',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'macOS, Linux',
            url: 'https://lykhoyda.github.io/rn-dev-agent/',
            author: { '@type': 'Person', name: 'Anton Lykhoyda', url: 'https://github.com/Lykhoyda' },
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/Lykhoyda/rn-dev-agent/edit/main/docs-site/',
      },
      components: {
        ThemeSelect: './src/components/ThemeSelect.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Getting Started', slug: 'getting-started' },
        { label: 'Architecture', slug: 'architecture' },
        { label: 'Actions', slug: 'actions' },
        { label: 'Troubleshooting Memory', slug: 'troubleshooting-memory' },
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
                { label: 'setup', slug: 'commands/setup' },
                { label: 'doctor', slug: 'commands/doctor' },
              ],
            },
            {
              label: 'Actions',
              items: [
                { label: 'list-learned-actions', slug: 'commands/list-learned-actions' },
                { label: 'run-action', slug: 'commands/run-action' },
              ],
            },
            {
              label: 'Proof & Testing',
              items: [
                { label: 'proof-capture', slug: 'commands/proof-capture' },
                { label: 'nav-graph', slug: 'commands/nav-graph' },
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
              label: 'CDP Tools',
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
        {
          label: 'Guides',
          items: [
            { label: 'React Native DevTools coexistence', slug: 'guides/devtools-coexistence' },
            { label: 'maestro-mcp interop', slug: 'guides/maestro-interop' },
          ],
        },
        { label: 'Benchmarks', slug: 'benchmarks' },
        { label: 'Troubleshooting', slug: 'troubleshooting' },
        { label: 'Changelog', slug: 'changelog' },
      ],
    }),
  ],
});
