// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
      sidebar: [
        {
          label: 'Guides',
          items: [{ label: 'Getting started', slug: 'guides/getting-started' }],
        },
      ],
    }),
  ],
});
