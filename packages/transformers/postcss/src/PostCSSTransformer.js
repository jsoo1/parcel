// @flow

import type {FilePath, MutableAsset} from '@parcel/types';

import {md5FromString} from '@parcel/utils';
import {Transformer} from '@parcel/plugin';
import FileSystemLoader from 'css-modules-loader-core/lib/file-system-loader';
import nullthrows from 'nullthrows';
import path from 'path';
import postcss from 'postcss';
import semver from 'semver';
import valueParser from 'postcss-value-parser';

import {load, preSerialize, postDeserialize} from './loadConfig';

const COMPOSES_RE = /composes:.+from\s*("|').*("|')\s*;?/;
const FROM_IMPORT_RE = /.+from\s*(?:"|')(.*)(?:"|')\s*;?/;

export default new Transformer({
  loadConfig({config, options, logger}) {
    return load({config, options, logger});
  },

  preSerializeConfig({config}) {
    return preSerialize(config);
  },

  postDeserializeConfig({config, options}) {
    return postDeserialize(config, options);
  },

  canReuseAST({ast}) {
    return ast.type === 'postcss' && semver.satisfies(ast.version, '^7.0.0');
  },

  async parse({asset, config}) {
    if (!config) {
      return;
    }

    return {
      type: 'postcss',
      version: '7.0.0',
      program: postcss.parse(await asset.getCode(), {
        from: asset.filePath,
      }),
    };
  },

  async transform({asset, config, options, resolve}) {
    if (!config) {
      return [asset];
    }

    let plugins = [...config.hydrated.plugins];
    if (config.hydrated.modules) {
      let postcssModules = await options.packageManager.require(
        'postcss-modules',
        asset.filePath,
        {autoinstall: options.autoinstall},
      );

      plugins.push(
        postcssModules({
          getJSON: (filename, json) => (asset.meta.cssModules = json),
          Loader: createLoader(asset, resolve),
          generateScopedName: (name, filename, css) =>
            `_${name}_${md5FromString(filename + css).substr(0, 5)}`,
          ...config.hydrated.modules,
        }),
      );
    }

    let ast = nullthrows(await asset.getAST());
    let code = asset.isASTDirty() ? null : await asset.getCode();
    if (code == null || COMPOSES_RE.test(code)) {
      ast.program.walkDecls(decl => {
        let [, importPath] = FROM_IMPORT_RE.exec(decl.value) || [];
        if (decl.prop === 'composes' && importPath != null) {
          let parsed = valueParser(decl.value);

          parsed.walk(node => {
            if (node.type === 'string') {
              asset.addDependency({
                moduleSpecifier: importPath,
                loc: {
                  filePath: importPath,
                  start: decl.source.start,
                  end: {
                    line: decl.source.start.line,
                    column: decl.source.start.column + importPath.length,
                  },
                },
              });
            }
          });
        }
      });
    }

    // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381
    let {messages, root} = await postcss(plugins).process(
      ast.program,
      config.hydrated,
    );
    ast.program = root;
    asset.setAST({
      type: 'postcss',
      version: '7.0.0',
      program: root,
    });
    for (let msg of messages) {
      if (msg.type === 'dependency') {
        msg = (msg: {|
          type: 'dependency',
          plugin: string,
          file: string,
          parent: string,
        |});

        asset.addIncludedFile({
          filePath: msg.file,
        });
      }
    }

    let assets = [asset];
    if (asset.meta.cssModules) {
      let code = JSON.stringify(asset.meta.cssModules, null, 2);
      let deps = asset.getDependencies().filter(dep => !dep.isURL);
      if (deps.length > 0) {
        code = `
          module.exports = Object.assign({}, ${deps
            .map(dep => `require(${JSON.stringify(dep.moduleSpecifier)})`)
            .join(', ')}, ${code});
        `;
      } else {
        code = `module.exports = ${code};`;
      }

      assets.push({
        type: 'js',
        filePath: asset.filePath + '.js',
        content: code,
      });
    }
    return assets;
  },

  generate({ast}) {
    let code = '';
    postcss.stringify(ast.program, c => {
      code += c;
    });

    return {
      content: code,
    };
  },
});

function createLoader(
  asset: MutableAsset,
  resolve: (from: FilePath, to: string) => Promise<FilePath>,
) {
  return class ParcelFileSystemLoader extends FileSystemLoader {
    async fetch(composesPath, relativeTo) {
      let importPath = composesPath.replace(/^["']|["']$/g, '');
      let resolved = await resolve(relativeTo, importPath);
      let rootRelativePath = path.resolve(path.dirname(relativeTo), resolved);
      let root = path.resolve('/');
      // fixes an issue on windows which is part of the css-modules-loader-core
      // see https://github.com/css-modules/css-modules-loader-core/issues/230
      if (rootRelativePath.startsWith(root)) {
        rootRelativePath = rootRelativePath.substr(root.length);
      }

      let source = await asset.fs.readFile(resolved, 'utf-8');
      let {exportTokens} = await this.core.load(
        source,
        rootRelativePath,
        undefined,
        this.fetch.bind(this),
      );
      return exportTokens;
    }

    get finalSource() {
      return '';
    }
  };
}
