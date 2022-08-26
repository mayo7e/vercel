import { dirname, join } from 'path';
import {
  debug,
  download,
  execCommand,
  getNodeVersion,
  getSpawnOptions,
  readConfigFile,
  runNpmInstall,
  runPackageJsonScript,
  scanParentDirs,
  BuildV3,
  PackageJson,
  glob,
} from '@vercel/build-utils';
import {
  createAPIRoutes,
  createFunctionLambda,
  createServerlessFunction,
} from './helpers/functions';
import { createStaticOutput } from './helpers/static';
import { getTransformedRoutes, Rewrite } from '@vercel/routing-utils';
import type { IGatsbyPage, IGatsbyState } from 'gatsby/dist/redux/types';

function hasScript(scriptName: string, pkg: PackageJson | null) {
  const scripts = (pkg && pkg.scripts) || {};
  return typeof scripts[scriptName] === 'string';
}

export const build: BuildV3 = async ({
  entrypoint,
  files,
  workPath,
  config,
  meta = {},
}) => {
  await download(files, workPath, meta);

  const { installCommand, buildCommand } = config;
  const mountpoint = dirname(entrypoint);
  const entrypointFsDirname = join(workPath, mountpoint);
  const nodeVersion = await getNodeVersion(
    entrypointFsDirname,
    undefined,
    config,
    meta
  );

  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  if (!spawnOpts.env) {
    spawnOpts.env = {};
  }
  const { cliType, lockfileVersion } = await scanParentDirs(
    entrypointFsDirname
  );

  if (cliType === 'npm') {
    if (
      typeof lockfileVersion === 'number' &&
      lockfileVersion >= 2 &&
      (nodeVersion?.major || 0) < 16
    ) {
      // Ensure that npm 7 is at the beginning of the `$PATH`
      spawnOpts.env.PATH = `/node16/bin-npm7:${spawnOpts.env.PATH}`;
      console.log('Detected `package-lock.json` generated by npm 7...');
    }
  } else if (cliType === 'pnpm') {
    if (typeof lockfileVersion === 'number' && lockfileVersion === 5.4) {
      // Ensure that pnpm 7 is at the beginning of the `$PATH`
      spawnOpts.env.PATH = `/pnpm7/node_modules/.bin:${spawnOpts.env.PATH}`;
      console.log('Detected `pnpm-lock.yaml` generated by pnpm 7...');
    }
  }

  if (typeof installCommand === 'string') {
    if (installCommand.trim()) {
      console.log(`Running "install" command: \`${installCommand}\`...`);

      const env: Record<string, string> = {
        YARN_NODE_LINKER: 'node-modules',
        ...spawnOpts.env,
      };

      await execCommand(installCommand, {
        ...spawnOpts,
        env,
        cwd: entrypointFsDirname,
      });
    } else {
      console.log(`Skipping "install" command...`);
    }
  } else {
    await runNpmInstall(entrypointFsDirname, [], spawnOpts, meta, nodeVersion);
  }

  // Run "Build Command"
  if (buildCommand) {
    debug(`Executing build command "${buildCommand}"`);
    await execCommand(buildCommand, {
      ...spawnOpts,
      cwd: entrypointFsDirname,
    });
  } else {
    const pkg = await readConfigFile<PackageJson>(
      join(entrypointFsDirname, 'package.json')
    );
    if (hasScript('vercel-build', pkg)) {
      debug(`Executing "yarn vercel-build"`);
      await runPackageJsonScript(
        entrypointFsDirname,
        'vercel-build',
        spawnOpts
      );
    } else if (hasScript('build', pkg)) {
      debug(`Executing "yarn build"`);
      await runPackageJsonScript(entrypointFsDirname, 'build', spawnOpts);
    } else {
      await execCommand('gatsby build', {
        ...spawnOpts,
        cwd: entrypointFsDirname,
      });
    }
  }

  const { store } = require('gatsby/dist/redux');
  const { pages } = store.getState() as IGatsbyState;
  const vercelConfig = await readConfigFile<{
    redirects?: [];
    rewrites?: [];
  }>(join(entrypointFsDirname, 'vercel.json'));

  const { ssrRoutes, dsgRoutes } = [...pages.values()].reduce(
    (acc, cur: IGatsbyPage) => {
      if (cur.mode === 'SSR') {
        acc.ssrRoutes.push(cur.path);
      } else if (cur.mode === 'DSG') {
        acc.dsgRoutes.push(cur.path);
      }

      return acc;
    },
    {
      ssrRoutes: [] as IGatsbyPage['path'][],
      dsgRoutes: [] as IGatsbyPage['path'][],
    }
  );

  const { routes } = getTransformedRoutes({
    trailingSlash: false,
    rewrites: [
      {
        source: '^/page-data(?:/(.*))/page-data\\.json$',
        destination: '/_page-data',
      },
      ...(vercelConfig?.rewrites as Rewrite[]),
    ],
    redirects: vercelConfig?.redirects,
  });

  return {
    output: {
      ...(await createStaticOutput({
        staticDir: join(entrypointFsDirname, 'public'),
      })),
      ...(await createServerlessFunction({
        ssrRoutes,
        dsgRoutes,
        nodeVersion,
      })),
      ...(await createAPIRoutes({
        functions: await glob('**', join(process.cwd(), 'src', 'api')),
        nodeVersion,
      })),
      'page-data': await createFunctionLambda({
        nodeVersion,
        handlerFile: join(
          __dirname,
          '..',
          'handlers',
          'templates',
          './page-data'
        ),
      }),
    },
    routes,
  };
};
