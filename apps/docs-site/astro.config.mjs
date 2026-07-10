import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://lykhoyda.github.io',
  base: '/rn-dev-agent',
  integrations: [
    starlight({
      plugins: [starlightLlmsTxt()],
      title: 'rn-dev-agent',
      description:
        'Claude Code and Codex plugin for React Native development — 79 MCP tools, 5 agents, 17 commands. Explore, build, verify, and test features live on iOS Simulator and Android Emulator via Chrome DevTools Protocol.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Lykhoyda/rn-dev-agent' },
      ],
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'keywords',
            content:
              'react native, claude code, codex, plugin, mcp, chrome devtools protocol, expo, ios simulator, android emulator, ai testing, mobile development',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://lykhoyda.github.io/rn-dev-agent/og-image.png',
          },
        },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        {
          tag: 'link',
          attrs: { rel: 'canonical', href: 'https://lykhoyda.github.io/rn-dev-agent/' },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'rn-dev-agent',
            description:
              'Claude Code and Codex plugin for React Native development with 79 MCP tools for live app verification via Chrome DevTools Protocol.',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'macOS, Linux',
            url: 'https://lykhoyda.github.io/rn-dev-agent/',
            author: {
              '@type': 'Person',
              name: 'Anton Lykhoyda',
              url: 'https://github.com/Lykhoyda',
            },
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/Lykhoyda/rn-dev-agent/edit/main/apps/docs-site/',
      },
      components: {
        ThemeSelect: './src/components/ThemeSelect.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
      },
      customCss: ['./src/styles/custom.css'],
      expressiveCode: {
        themes: ['github-dark'],
        styleOverrides: {
          borderColor: 'var(--sl-color-gray-5)',
          borderRadius: '8px',
          frames: {
            terminalTitlebarBackground: 'var(--sl-color-gray-6)',
            terminalTitlebarBorderBottomColor: 'var(--sl-color-gray-5)',
          },
        },
      },
      sidebar: [
        {
          label: 'Start Here',
          items: [{ label: 'Getting Started', slug: 'getting-started' }],
        },
        {
          label: 'Core Concepts',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Actions', slug: 'actions' },
            { label: 'Troubleshooting Memory', slug: 'troubleshooting-memory' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'React Native DevTools coexistence', slug: 'guides/devtools-coexistence' },
            { label: 'maestro-mcp interop', slug: 'guides/maestro-interop' },
            { label: 'Dev Client coverage', slug: 'dev-client-coverage' },
          ],
        },
        {
          label: 'Reference',
          items: [
            {
              label: 'Commands',
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'commands' },
                { label: 'rn-feature-dev', slug: 'commands/rn-feature-dev' },
                { label: 'test-feature', slug: 'commands/test-feature' },
                { label: 'build-and-test', slug: 'commands/build-and-test' },
                { label: 'debug-screen', slug: 'commands/debug-screen' },
                { label: 'check-env', slug: 'commands/check-env' },
                { label: 'setup', slug: 'commands/setup' },
                { label: 'doctor', slug: 'commands/doctor' },
                { label: 'list-learned-actions', slug: 'commands/list-learned-actions' },
                { label: 'run-action', slug: 'commands/run-action' },
                { label: 'proof-capture', slug: 'commands/proof-capture' },
                { label: 'nav-graph', slug: 'commands/nav-graph' },
                { label: 'send-feedback', slug: 'commands/send-feedback' },
              ],
            },
            {
              label: 'MCP Tools',
              items: [
                { label: 'Overview', slug: 'tools' },
                { label: 'CDP Tools', collapsed: true, autogenerate: { directory: 'tools/cdp' } },
                { label: 'Device Tools', collapsed: true, autogenerate: { directory: 'tools/device' } },
                { label: 'Testing Tools', collapsed: true, autogenerate: { directory: 'tools/testing' } },
              ],
            },
            {
              label: 'Agents',
              collapsed: true,
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
              collapsed: true,
              items: [
                { label: 'Overview', slug: 'skills' },
                { label: 'Device Control', slug: 'skills/rn-device-control' },
                { label: 'Testing', slug: 'skills/rn-testing' },
                { label: 'Debugging', slug: 'skills/rn-debugging' },
                { label: 'Best Practices', slug: 'skills/rn-best-practices' },
              ],
            },
            { label: 'Best Practices', slug: 'best-practices' },
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'Benchmarks', slug: 'benchmarks' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
            { label: 'Changelog', slug: 'changelog' },
          ],
        },
      ],
    }),
  ],
});
