// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

export default defineConfig({
  site: 'https://andyshinn.as',
  base: '/meshcore-ts',
  // Always emit/serve trailing-slash directory URLs so relative internal links
  // (e.g. ../transports/) resolve correctly under the base path in dev,
  // preview, and on GitHub Pages — without it, the dev homepage URL lacks the
  // trailing slash and relative links drop the /meshcore-ts base.
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'meshcore-ts',
      description:
        'MeshCore companion-protocol library for Node.js in TypeScript.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/andyshinn/meshcore-ts',
        },
      ],
      plugins: [
        starlightLlmsTxt(),
        starlightTypeDoc({
          entryPoints: ['../src/index.ts'],
          tsconfig: '../tsconfig.json',
          typeDoc: {
            // One page per namespace (the `export * as` namespaces). The default
            // 'members' strategy explodes each member into its own file but emits
            // no namespace index page, leaving the API home page's namespace links
            // (…/namespaces/<ns>/readme/) broken. 'modules' generates the landing
            // page each namespace link targets.
            outputFileStrategy: 'modules',
            // Formatting: code blocks for signatures, tables for parameters.
            useCodeBlocks: true,
            parametersFormat: 'table',
          },
        }),
      ],
      sidebar: [
        {
          label: 'Guides',
          items: [
            { label: 'Getting started', slug: 'guides/getting-started' },
            { label: 'Transports', slug: 'guides/transports' },
            { label: 'Messaging', slug: 'guides/messaging' },
            { label: 'Events & state', slug: 'guides/events-and-state' },
            { label: 'Decoding packets', slug: 'guides/decoding-packets' },
          ],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
});
