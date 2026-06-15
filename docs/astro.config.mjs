// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

export default defineConfig({
  site: 'https://andyshinn.github.io',
  base: '/meshcore-ts',
  integrations: [
    starlight({
      title: 'meshcore-ts',
      description:
        'Application-agnostic MeshCore companion-protocol library for Node.js, in TypeScript.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/andyshinn/meshcore-ts',
        },
      ],
      plugins: [
        starlightTypeDoc({
          entryPoints: ['../src/index.ts'],
          tsconfig: '../tsconfig.json',
          typeDoc: {
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
            // Task 4 will create these pages; using `link` avoids a hard build error
            // when slug-based references point to non-existent content collection entries.
            // Switch back to `slug` once the pages exist.
            { label: 'Transports', link: 'guides/transports' },
            { label: 'Messaging', link: 'guides/messaging' },
            { label: 'Events & state', link: 'guides/events-and-state' },
          ],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
});
