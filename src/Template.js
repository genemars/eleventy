const fs = require("graceful-fs");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

const os = require("os");
const path = require("path");
const normalize = require("normalize-path");
const lodashGet = require("lodash/get");
const lodashSet = require("lodash/set");
const { DateTime } = require("luxon");

const isPlainObject = require("./Util/IsPlainObject");
const ConsoleLogger = require("./Util/ConsoleLogger");
const getDateFromGitLastUpdated = require("./Util/DateGitLastUpdated");

const TemplateData = require("./TemplateData");
const TemplateContent = require("./TemplateContent");
const TemplatePath = require("./TemplatePath");
const TemplatePermalink = require("./TemplatePermalink");
const TemplateLayout = require("./TemplateLayout");
const TemplateFileSlug = require("./TemplateFileSlug");
const ComputedData = require("./ComputedData");
const Pagination = require("./Plugins/Pagination");
const TemplateBehavior = require("./TemplateBehavior");

const TemplateContentPrematureUseError = require("./Errors/TemplateContentPrematureUseError");
const TemplateContentUnrenderedTemplateError = require("./Errors/TemplateContentUnrenderedTemplateError");

const EleventyBaseError = require("./EleventyBaseError");
class EleventyTransformError extends EleventyBaseError {}

const debug = require("debug")("Eleventy:Template");
const debugDev = require("debug")("Dev:Eleventy:Template");

class Template extends TemplateContent {
  constructor(
    templatePath,
    inputDir,
    outputDir,
    templateData,
    extensionMap,
    config
  ) {
    debugDev("new Template(%o)", templatePath);
    super(templatePath, inputDir, config);

    this.parsed = path.parse(templatePath);

    // for pagination
    this.extraOutputSubdirectory = "";

    if (outputDir) {
      this.outputDir = normalize(outputDir);
    } else {
      this.outputDir = false;
    }

    this.extensionMap = extensionMap;

    this.linters = [];
    this.transforms = [];
    this.templateData = templateData;
    if (this.templateData) {
      this.templateData.setInputDir(this.inputDir);
    }
    this.paginationData = {};

    this.isVerbose = true;
    this.isDryRun = false;
    this.writeCount = 0;
    this.skippedCount = 0;
    this.wrapWithLayouts = true;
    this.fileSlug = new TemplateFileSlug(
      this.inputPath,
      this.inputDir,
      this.extensionMap
    );
    this.fileSlugStr = this.fileSlug.getSlug();
    this.filePathStem = this.fileSlug.getFullPathWithoutExtension();

    this.outputFormat = "fs";

    this.behavior = new TemplateBehavior(this.config);
    this.behavior.setOutputFormat(this.outputFormat);

    this.serverlessUrls = null;
  }

  get logger() {
    if (!this._logger) {
      this._logger = new ConsoleLogger();
      this._logger.isVerbose = this.isVerbose;
    }
    return this._logger;
  }

  /* Setter for Logger */
  set logger(logger) {
    this._logger = logger;
  }

  setOutputFormat(to) {
    this.outputFormat = to;
    this.behavior.setOutputFormat(to);
  }

  setIsVerbose(isVerbose) {
    this.isVerbose = isVerbose;
    this.logger.isVerbose = isVerbose;
  }

  setDryRun(isDryRun) {
    this.isDryRun = !!isDryRun;
  }

  setWrapWithLayouts(wrap) {
    this.wrapWithLayouts = wrap;
  }

  setExtraOutputSubdirectory(dir) {
    this.extraOutputSubdirectory = dir + "/";
  }

  getTemplateSubfolder() {
    return TemplatePath.stripLeadingSubPath(this.parsed.dir, this.inputDir);
  }

  getLayout(layoutKey) {
    if (!this._layout || layoutKey !== this._layoutKey) {
      this._layoutKey = layoutKey;
      this._layout = TemplateLayout.getTemplate(
        layoutKey,
        this.getInputDir(),
        this.config,
        this.extensionMap
      );
    }
    return this._layout;
  }

  async _testGetLayoutChain() {
    if (!this._layout) {
      await this.getData();
    }

    return this._layout._testGetLayoutChain();
  }

  get baseFile() {
    return this.extensionMap.removeTemplateExtension(this.parsed.base);
  }

  get htmlIOException() {
    // HTML output can’t overwrite the HTML input file.
    return (
      this.inputDir === this.outputDir &&
      this.templateRender.isEngine("html") &&
      this.baseFile === "index"
    );
  }

  getServerlessUrls() {
    if (!this.serverlessUrls) {
      throw new Error(
        "Permalink has not yet processed. Calls to Template->getServerlessUrls not yet allowed."
      );
    }
    return this.serverlessUrls;
  }

  initServerlessUrlsForEmptyPaginationTemplates(permalinkValue) {
    if (isPlainObject(permalinkValue)) {
      let buildlessPermalink = Object.assign({}, permalinkValue);
      delete buildlessPermalink.build;

      if (Object.keys(buildlessPermalink).length) {
        return this._getRawPermalinkInstance(buildlessPermalink);
      }
    }
  }

  _getRawPermalinkInstance(permalinkValue) {
    let perm = new TemplatePermalink(
      permalinkValue,
      this.extraOutputSubdirectory
    );
    if (this.templateData) {
      perm.setServerlessPathData(this.templateData.getServerlessPathData());
    }

    this.behavior.setFromPermalink(perm);
    this.serverlessUrls = perm.getServerlessUrls();

    return perm;
  }

  async _getLink(data) {
    if (!data) {
      data = await this.getData();
    }

    let permalink = data[this.config.keys.permalink];
    let permalinkValue;

    // `permalink: false` means render but no file system write, e.g. use in collections only)
    // `permalink: true` throws an error
    if (typeof permalink === "boolean") {
      debugDev("Using boolean permalink %o", permalink);
      permalinkValue = permalink;
    } else if (
      permalink &&
      (!this.config.dynamicPermalinks || data.dynamicPermalink === false)
    ) {
      debugDev("Not using dynamic permalinks, using %o", permalink);
      permalinkValue = permalink;
    } else if (isPlainObject(permalink)) {
      // Empty permalink {} object should act as if no permalink was set at all
      // and inherit the default behavior
      let isEmptyObject = Object.keys(permalink).length === 0;
      if (!isEmptyObject) {
        let promises = [];
        let keys = [];
        for (let key in permalink) {
          keys.push(key);
          if (key !== "build" && Array.isArray(permalink[key])) {
            promises.push(
              Promise.all(
                [...permalink[key]].map((entry) =>
                  super.renderPermalink(entry, data)
                )
              )
            );
          } else {
            promises.push(super.renderPermalink(permalink[key], data));
          }
        }

        let results = await Promise.all(promises);

        permalinkValue = {};
        for (let j = 0, k = keys.length; j < k; j++) {
          let key = keys[j];
          permalinkValue[key] = results[j];
          debug(
            "Rendering permalink.%o for %o: %s becomes %o",
            key,
            this.inputPath,
            permalink[key],
            results[j]
          );
        }
      }
    } else if (permalink) {
      // render variables inside permalink front matter, bypass markdown
      permalinkValue = await super.renderPermalink(permalink, data);
      debug(
        "Rendering permalink for %o: %s becomes %o",
        this.inputPath,
        permalink,
        permalinkValue
      );
      debugDev("Permalink rendered with data: %o", data);
    }

    // Override default permalink behavior. Only do this if permalink was _not_ in the data cascade
    if (!permalink) {
      let permalinkCompilation = this.engine.permalinkNeedsCompilation("");
      if (typeof permalinkCompilation === "function") {
        let ret = await this._renderFunction(
          permalinkCompilation,
          permalinkValue,
          this.inputPath
        );
        if (ret !== undefined) {
          if (typeof ret === "function") {
            // function
            permalinkValue = await this._renderFunction(ret, data);
          } else {
            // scalar
            permalinkValue = ret;
          }
        }
      }
    }

    if (permalinkValue !== undefined) {
      return this._getRawPermalinkInstance(permalinkValue);
    }

    // No `permalink` specified in data cascade, do the default
    return TemplatePermalink.generate(
      this.getTemplateSubfolder(),
      this.baseFile,
      this.extraOutputSubdirectory,
      this.htmlIOException ? this.config.htmlOutputSuffix : "",
      this.engine.defaultTemplateFileExtension
    );
  }

  async usePermalinkRoot() {
    if (this._usePermalinkRoot === undefined) {
      // TODO this only works with immediate front matter and not data files
      this._usePermalinkRoot = (await this.getFrontMatterData())[
        this.config.keys.permalinkRoot
      ];
    }

    return this._usePermalinkRoot;
  }

  // TODO instead of htmlIOException, do a global search to check if output path = input path and then add extra suffix
  async getOutputLocations(data) {
    let link = await this._getLink(data);

    let path;
    if (await this.usePermalinkRoot()) {
      path = link.toPathFromRoot();
    } else {
      path = link.toPath(this.outputDir);
    }

    return {
      rawPath: link.toOutputPath(),
      href: link.toHref(),
      path: path,
    };
  }

  // Preferred to use the singular `getOutputLocations` above.
  async getRawOutputPath(data) {
    let link = await this._getLink(data);
    return link.toOutputPath();
  }

  // Preferred to use the singular `getOutputLocations` above.
  async getOutputHref(data) {
    let link = await this._getLink(data);
    return link.toHref();
  }

  // Preferred to use the singular `getOutputLocations` above.
  async getOutputPath(data) {
    let link = await this._getLink(data);
    if (await this.usePermalinkRoot()) {
      return link.toPathFromRoot();
    }
    return link.toPath(this.outputDir);
  }

  setPaginationData(paginationData) {
    this.paginationData = paginationData;
  }

  async mapDataAsRenderedTemplates(data, templateData) {
    // function supported in JavaScript type
    if (typeof data === "string" || typeof data === "function") {
      debug("rendering data.renderData for %o", this.inputPath);
      // bypassMarkdown
      let str = await super.render(data, templateData, true);
      return str;
    } else if (Array.isArray(data)) {
      return Promise.all(
        data.map((item) => this.mapDataAsRenderedTemplates(item, templateData))
      );
    } else if (isPlainObject(data)) {
      let obj = {};
      await Promise.all(
        Object.keys(data).map(async (value) => {
          obj[value] = await this.mapDataAsRenderedTemplates(
            data[value],
            templateData
          );
        })
      );
      return obj;
    }

    return data;
  }

  async _testGetAllLayoutFrontMatterData() {
    let frontMatterData = await this.getFrontMatterData();
    if (frontMatterData[this.config.keys.layout]) {
      let layout = this.getLayout(frontMatterData[this.config.keys.layout]);
      return await layout.getData();
    }
    return {};
  }

  async getData() {
    if (!this.dataCache) {
      debugDev("%o getData()", this.inputPath);
      let localData = {};
      let globalData = {};

      if (this.templateData) {
        localData = await this.templateData.getTemplateDirectoryData(
          this.inputPath
        );
        globalData = await this.templateData.getGlobalData(this.inputPath);
        debugDev(
          "%o getData() getTemplateDirectoryData and getGlobalData",
          this.inputPath
        );
      }

      let frontMatterData = await this.getFrontMatterData();
      let layoutKey =
        frontMatterData[this.config.keys.layout] ||
        localData[this.config.keys.layout] ||
        globalData[this.config.keys.layout];

      // Layout front matter data
      let mergedLayoutData = {};
      if (layoutKey) {
        let layout = this.getLayout(layoutKey);

        mergedLayoutData = await layout.getData();
        debugDev(
          "%o getData() get merged layout chain front matter",
          this.inputPath
        );
      }

      let mergedData = TemplateData.mergeDeep(
        this.config,
        {},
        globalData,
        mergedLayoutData,
        localData,
        frontMatterData
      );
      mergedData = await this.addPageDate(mergedData);
      mergedData = this.addPageData(mergedData);
      debugDev("%o getData() mergedData", this.inputPath);

      this.dataCache = mergedData;
    }

    // Don’t deep merge pagination data! See https://github.com/11ty/eleventy/issues/147#issuecomment-440802454
    return Object.assign(
      TemplateData.mergeDeep(this.config, {}, this.dataCache),
      this.paginationData
    );
  }

  async addPageDate(data) {
    if (!("page" in data)) {
      data.page = {};
    }

    let newDate = await this.getMappedDate(data);

    if ("page" in data && "date" in data.page) {
      debug(
        "Warning: data.page.date is in use (%o) will be overwritten with: %o",
        data.page.date,
        newDate
      );
    }

    data.page.date = newDate;

    return data;
  }

  addPageData(data) {
    if (!("page" in data)) {
      data.page = {};
    }

    data.page.inputPath = this.inputPath;
    data.page.fileSlug = this.fileSlugStr;
    data.page.filePathStem = this.filePathStem;
    data.page.outputFileExtension = this.engine.defaultTemplateFileExtension;

    return data;
  }

  async renderLayout(tmpl, tmplData) {
    let layoutKey = tmplData[tmpl.config.keys.layout];
    let layout = this.getLayout(layoutKey);
    debug("%o is using layout %o", this.inputPath, layoutKey);

    // TODO reuse templateContent from templateMap
    let templateContent = await super.render(
      await this.getPreRender(),
      tmplData
    );
    return layout.render(tmplData, templateContent);
  }

  async _testRenderWithoutLayouts(data) {
    this.setWrapWithLayouts(false);
    let ret = await this.render(data);
    this.setWrapWithLayouts(true);
    return ret;
  }

  // Used only by tests
  async renderContent(str, data, bypassMarkdown) {
    return super.render(str, data, bypassMarkdown);
  }

  async render(data) {
    debugDev("%o render()", this.inputPath);
    if (!data) {
      throw new Error("`data` needs to be passed into render()");
    }

    if (!this.wrapWithLayouts && data[this.config.keys.layout]) {
      debugDev("Template.render is bypassing layouts for %o.", this.inputPath);
    }

    if (this.wrapWithLayouts && data[this.config.keys.layout]) {
      debugDev(
        "Template.render found layout: %o",
        data[this.config.keys.layout]
      );
      return this.renderLayout(this, data);
    } else {
      debugDev("Template.render renderContent for %o", this.inputPath);
      return super.render(await this.getPreRender(), data);
    }
  }

  addLinter(callback) {
    this.linters.push(callback);
  }

  async runLinters(str, inputPath, outputPath) {
    for (let linter of this.linters) {
      // these can be asynchronous but no guarantee of order when they run
      linter.call(
        {
          inputPath,
          outputPath,
        },
        str,
        inputPath,
        outputPath
      );
    }
  }

  addTransform(name, callback) {
    this.transforms.push({
      name,
      callback,
    });
  }

  async runTransforms(str, inputPath, outputPath) {
    for (let { callback, name } of this.transforms) {
      try {
        let hadStrBefore = !!str;
        str = await callback.call(
          {
            inputPath,
            outputPath,
          },
          str,
          outputPath
        );
        if (hadStrBefore && !str) {
          this.logger.warn(
            `Warning: Transform \`${name}\` returned empty when writing ${outputPath} from ${inputPath}.`
          );
        }
      } catch (e) {
        throw new EleventyTransformError(
          `Transform \`${name}\` encountered an error when transforming ${inputPath}.`,
          e
        );
      }
    }

    return str;
  }

  _addComputedEntry(computedData, obj, parentKey, declaredDependencies) {
    // this check must come before isPlainObject
    if (typeof obj === "function") {
      computedData.add(parentKey, obj, declaredDependencies);
    } else if (Array.isArray(obj) || isPlainObject(obj)) {
      for (let key in obj) {
        let keys = [];
        if (parentKey) {
          keys.push(parentKey);
        }
        keys.push(key);
        this._addComputedEntry(
          computedData,
          obj[key],
          keys.join("."),
          declaredDependencies
        );
      }
    } else if (typeof obj === "string") {
      computedData.addTemplateString(
        parentKey,
        async (innerData) => {
          return await this.renderComputedData(obj, innerData, true);
        },
        declaredDependencies,
        this.getParseForSymbolsFunction(obj)
      );
    } else {
      // Numbers, booleans, etc
      computedData.add(parentKey, obj, declaredDependencies);
    }
  }

  async addComputedData(data) {
    // will _not_ consume renderData
    this.computedData = new ComputedData(this.config);

    if (this.config.keys.computed in data) {
      // Note that `permalink` is only a thing that gets consumed—it does not go directly into generated data
      // this allows computed entries to use page.url or page.outputPath and they’ll be resolved properly

      this.computedData.addTemplateString(
        "page.url",
        async (data) => await this.getOutputHref(data),
        data.permalink ? ["permalink"] : undefined,
        false // skip symbol resolution
      );

      this.computedData.addTemplateString(
        "page.outputPath",
        async (data) => await this.getOutputPath(data),
        data.permalink ? ["permalink"] : undefined,
        false // skip symbol resolution
      );

      // actually add the computed data
      this._addComputedEntry(
        this.computedData,
        data[this.config.keys.computed]
      );

      // limited run of computed data—save the stuff that relies on collections for later.
      debug("First round of computed data for %o", this.inputPath);
      await this.computedData.setupData(data, function (entry) {
        return !this.isUsesStartsWith(entry, "collections.");

        // TODO possible improvement here is to only process page.url, page.outputPath, permalink
        // instead of only punting on things that rely on collections.
        // let firstPhaseComputedData = ["page.url", "page.outputPath", ...this.getOrderFor("page.url"), ...this.getOrderFor("page.outputPath")];
        // return firstPhaseComputedData.indexOf(entry) > -1;
      });
    } else {
      if (!("page" in data)) {
        data.page = {};
      }

      let { href, path } = await this.getOutputLocations(data);
      data.page.url = href;
      data.page.outputPath = path;
    }

    // Deprecated, use eleventyComputed instead.
    if ("renderData" in data) {
      data.renderData = await this.mapDataAsRenderedTemplates(
        data.renderData,
        data
      );
    }
  }

  async resolveRemainingComputedData(data) {
    debug("Second round of computed data for %o", this.inputPath);
    await this.computedData.processRemainingData(data);
  }

  async getTemplates(data) {
    // no pagination with permalink.serverless
    let hasPagination = Pagination.hasPagination(data);

    if (!hasPagination) {
      await this.addComputedData(data);

      return [
        {
          template: this,
          inputPath: this.inputPath,
          fileSlug: this.fileSlugStr,
          filePathStem: this.filePathStem,
          data: data,
          date: data.page.date,
          outputPath: data.page.outputPath,
          url: data.page.url,
          checkTemplateContent: true,
          set templateContent(content) {
            if (content === undefined) {
              this.checkTemplateContent = false;
            }
            this._templateContent = content;
          },
          get templateContent() {
            if (
              this.checkTemplateContent &&
              this._templateContent === undefined
            ) {
              if (this.template.behavior.isRenderable()) {
                // should at least warn here
                throw new TemplateContentPrematureUseError(
                  `Tried to use templateContent too early (${this.inputPath})`
                );
              } else {
                throw new TemplateContentUnrenderedTemplateError(
                  `Tried to use templateContent on unrendered template. You need a valid permalink (or permalink object) to use templateContent on ${this.inputPath}`
                );
              }
            }
            return this._templateContent;
          },
        },
      ];
    } else {
      // needs collections for pagination items
      // but individual pagination entries won’t be part of a collection
      this.paging = new Pagination(data, this.config);
      this.paging.setTemplate(this);

      let pageTemplates = await this.paging.getPageTemplates();

      return await Promise.all(
        pageTemplates.map(async (page, pageNumber) => {
          // TODO get smarter with something like Object.assign(data, override);
          let pageData = Object.assign({}, await page.getData());

          await page.addComputedData(pageData);

          // Issue #115
          if (data.collections) {
            pageData.collections = data.collections;
          }

          return {
            template: page,
            inputPath: this.inputPath,
            fileSlug: this.fileSlugStr,
            filePathStem: this.filePathStem,
            data: pageData,
            date: pageData.page.date,
            pageNumber: pageNumber,
            outputPath: pageData.page.outputPath,
            url: pageData.page.url,
            checkTemplateContent: true,
            set templateContent(content) {
              if (content === undefined) {
                this.checkTemplateContent = false;
              }
              this._templateContent = content;
            },
            get templateContent() {
              if (
                this.checkTemplateContent &&
                this._templateContent === undefined
              ) {
                if (this.template.behavior.isRenderable()) {
                  throw new TemplateContentPrematureUseError(
                    `Tried to use templateContent too early (${this.inputPath} page ${this.pageNumber})`
                  );
                } else {
                  throw new TemplateContentUnrenderedTemplateError(
                    `Tried to use templateContent on unrendered template. You need a valid permalink (or permalink object) to use templateContent on ${this.inputPath} page ${this.pageNumber}`
                  );
                }
              }
              return this._templateContent;
            },
          };
        })
      );
    }
  }

  // TODO move this into tests (this is only used by tests)
  async getRenderedTemplates(data) {
    let pages = await this.getTemplates(data);
    await Promise.all(
      pages.map(async (page) => {
        let content = await page.template.render(page.data);

        page.templateContent = content;
      })
    );
    return pages;
  }

  async _write(outputPath, finalContent) {
    let shouldWriteFile = true;

    if (this.isDryRun) {
      shouldWriteFile = false;
    }

    let lang = {
      start: "Writing",
      finished: "written.",
    };

    if (!shouldWriteFile) {
      lang = {
        start: "Skipping",
        finished: "", // not used, promise doesn’t resolve
      };
    }

    let engineList =
      this.templateRender.getReadableEnginesListDifferingFromFileExtension();
    this.logger.log(
      `${lang.start} ${outputPath} from ${this.inputPath}${
        engineList ? ` (${engineList})` : ""
      }`
    );

    if (!shouldWriteFile) {
      this.skippedCount++;
    } else {
      let templateBenchmark = this.bench.get("Template Write");
      templateBenchmark.before();

      // TODO add a cache to check if this was already created
      let templateOutputDir = path.parse(outputPath).dir;
      if (templateOutputDir) {
        await mkdir(templateOutputDir, { recursive: true });
      }

      if (!Buffer.isBuffer(finalContent) && typeof finalContent !== "string") {
        throw new Error(
          `The return value from the render function for the ${this.engine.name} template was not a String or Buffer. Received ${finalContent}`
        );
      }

      return writeFile(outputPath, finalContent).then(() => {
        templateBenchmark.after();
        this.writeCount++;
        debug(`${outputPath} ${lang.finished}.`);
      });
    }
  }

  async renderPageEntry(mapEntry, page) {
    let content;
    let layoutKey = mapEntry.data[this.config.keys.layout];
    if (layoutKey) {
      let layout = this.getLayout(layoutKey);

      content = await layout.render(page.data, page.templateContent);
    } else {
      content = page.templateContent;
    }

    await this.runLinters(content, page.inputPath, page.outputPath);
    content = await this.runTransforms(
      content,
      page.inputPath,
      page.outputPath
    );
    return content;
  }

  retrieveDataForJsonOutput(data, selectors) {
    let filtered = {};
    for (let selector of selectors) {
      let value = lodashGet(data, selector);
      lodashSet(filtered, selector, value);
    }
    return filtered;
  }

  async generateMapEntry(mapEntry, to) {
    return Promise.all(
      mapEntry._pages.map(async (page) => {
        let content;
        // Note that behavior.render is overridden when using json or ndjson output
        if (mapEntry.template.behavior.isRenderable()) {
          // this reuses page.templateContent, it doesn’t render it
          content = await this.renderPageEntry(mapEntry, page);
        }

        if (to === "json" || to === "ndjson") {
          let obj = {
            url: page.url,
            inputPath: page.inputPath,
            outputPath: page.outputPath,
            content: content,
          };

          if (
            this.config.dataFilterSelectors &&
            this.config.dataFilterSelectors.size > 0
          ) {
            obj.data = this.retrieveDataForJsonOutput(
              page.data,
              this.config.dataFilterSelectors
            );
          }

          if (to === "ndjson") {
            let jsonString = JSON.stringify(obj);
            this.logger.toStream(jsonString + os.EOL);
            return;
          }

          // json
          return obj;
        }

        if (!mapEntry.template.behavior.isRenderable()) {
          debug(
            "Template not written %o from %o (via serverless permalink).",
            page.outputPath,
            mapEntry.template.inputPath
          );
          return;
        }

        if (!mapEntry.template.behavior.isWriteable()) {
          debug(
            "Template not written %o from %o (via permalink: false, permalink.build: false, or a permalink object without a build property).",
            page.outputPath,
            mapEntry.template.inputPath
          );
          return;
        }

        // compile returned undefined
        if (content !== undefined) {
          return this._write(page.outputPath, content);
        }
      })
    );
  }

  // TODO this but better
  clone() {
    let tmpl = new Template(
      this.inputPath,
      this.inputDir,
      this.outputDir,
      this.templateData,
      this.extensionMap,
      this.eleventyConfig
    );

    // Avoid re-reads, especially for pagination
    tmpl.setInputContent(this.inputContent);

    tmpl.logger = this.logger;

    for (let transform of this.transforms) {
      tmpl.addTransform(transform.name, transform.callback);
    }
    for (let linter of this.linters) {
      tmpl.addLinter(linter);
    }
    tmpl.setIsVerbose(this.isVerbose);
    tmpl.setDryRun(this.isDryRun);

    return tmpl;
  }

  getWriteCount() {
    return this.writeCount;
  }

  getSkippedCount() {
    return this.skippedCount;
  }

  async getInputFileStat() {
    if (this._stats) {
      return this._stats;
    }

    this._stats = fs.promises.stat(this.inputPath);

    return this._stats;
  }

  async _getDateInstance(key = "birthtimeMs") {
    let stat = await this.getInputFileStat();

    // Issue 1823: https://github.com/11ty/eleventy/issues/1823
    // return current Date in a Lambda
    // otherwise ctime would be "1980-01-01T00:00:00.000Z"
    // otherwise birthtime would be "1970-01-01T00:00:00.000Z"
    if (stat.birthtimeMs === 0) {
      return new Date();
    }

    let newDate = new Date(stat[key]);

    debug(
      "Template date: using file’s %o for %o of %o (from %o)",
      key,
      this.inputPath,
      newDate,
      stat.birthtimeMs
    );

    return newDate;
  }

  async getMappedDate(data) {
    if ("date" in data && data.date) {
      debug(
        "getMappedDate: using a date in the data for %o of %o",
        this.inputPath,
        data.date
      );
      if (data.date instanceof Date) {
        // YAML does its own date parsing
        debug("getMappedDate: YAML parsed it: %o", data.date);
        return data.date;
      }

      // special strings
      if (data.date.toLowerCase() === "git last modified") {
        let d = getDateFromGitLastUpdated(this.inputPath);
        if (d) {
          return d;
        }

        // return now if this file is not yet available in `git`
        return Date.now();
      }
      if (data.date.toLowerCase() === "last modified") {
        return this._getDateInstance("ctimeMs");
      }
      if (data.date.toLowerCase() === "created") {
        return this._getDateInstance("birthtimeMs");
      }

      // try to parse with Luxon
      let date = DateTime.fromISO(data.date, { zone: "utc" });
      if (!date.isValid) {
        throw new Error(
          `date front matter value (${data.date}) is invalid for ${this.inputPath}`
        );
      }
      debug(
        "getMappedDate: Luxon parsed %o: %o and %o",
        data.date,
        date,
        date.toJSDate()
      );

      return date.toJSDate();
    } else {
      let filepathRegex = this.inputPath.match(/(\d{4}-\d{2}-\d{2})/);
      if (filepathRegex !== null) {
        let dateObj = DateTime.fromISO(filepathRegex[1], {
          zone: "utc",
        }).toJSDate();
        debug(
          "getMappedDate: using filename regex time for %o of %o: %o",
          this.inputPath,
          filepathRegex[1],
          dateObj
        );
        return dateObj;
      }

      return this._getDateInstance("birthtimeMs");
    }
  }

  /* This is the primary render mechanism, called via TemplateMap->populateContentDataInMap */
  async getTemplateMapContent(pageMapEntry) {
    pageMapEntry.template.setWrapWithLayouts(false);
    let content = await pageMapEntry.template.render(pageMapEntry.data);
    pageMapEntry.template.setWrapWithLayouts(true);

    return content;
  }

  async getTemplateMapEntries(dataOverride) {
    debugDev("%o getMapped()", this.inputPath);

    // Important reminder: This is where the template data is first generated via TemplateMap
    let data = dataOverride || (await this.getData());

    this.behavior.setRenderViaDataCascade(data);

    let entries = [];
    // does not return outputPath or url, we don’t want to render permalinks yet
    entries.push({
      template: this,
      inputPath: this.inputPath,
      data,
    });

    return entries;
  }

  async _testCompleteRender() {
    let entries = await this.getTemplateMapEntries();

    let nestedContent = await Promise.all(
      entries.map(async (entry) => {
        entry._pages = await entry.template.getTemplates(entry.data);
        return Promise.all(
          entry._pages.map(async (page) => {
            page.templateContent = await entry.template.getTemplateMapContent(
              page
            );
            return this.renderPageEntry(entry, page);
          })
        );
      })
    );

    let contents = [].concat(...nestedContent);
    return contents;
  }
}

module.exports = Template;
