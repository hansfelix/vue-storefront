import Vue from 'vue'
import { ActionTree } from 'vuex'
import * as types from './mutation-types'
import { formatBreadCrumbRoutes, isServer } from '@vue-storefront/core/helpers'
import { currentStoreView } from '@vue-storefront/core/lib/multistore'
import { configureProductAsync,
  doPlatformPricesSync,
  filterOutUnavailableVariants,
  populateProductConfigurationAsync,
  setCustomProductOptionsAsync,
  setBundleProductOptionsAsync,
  getMediaGallery,
  configurableChildrenImages,
  calculateTaxes,
  attributeImages } from '../../helpers'
import { preConfigureProduct, getOptimizedFields, configureChildren, storeProductToCache, canCache, isGroupedOrBundle } from '@vue-storefront/core/modules/catalog/helpers/search'
import SearchQuery from '@vue-storefront/core/lib/search/searchQuery'
import { entityKeyName } from '@vue-storefront/core/store/lib/entities'
import { optionLabel } from '../../helpers/optionLabel'
import { isOnline } from '@vue-storefront/core/lib/search'
import omit from 'lodash-es/omit'
import trim from 'lodash-es/trim'
import uniqBy from 'lodash-es/uniqBy'
import rootStore from '@vue-storefront/core/store'
import RootState from '@vue-storefront/core/types/RootState'
import ProductState from '../../types/ProductState'
import { Logger } from '@vue-storefront/core/lib/logger';
import { TaskQueue } from '@vue-storefront/core/lib/sync'
import toString from 'lodash-es/toString'
import config from 'config'
import EventBus from '@vue-storefront/core/compatibility/plugins/event-bus'
import { StorageManager } from '@vue-storefront/core/lib/storage-manager'
import { quickSearchByQuery } from '@vue-storefront/core/lib/search'

const PRODUCT_REENTER_TIMEOUT = 20000

const actions: ActionTree<ProductState, RootState> = {
  /**
   * Reset current configuration and selected variatnts
   */
  reset (context) {
    const productOriginal = context.getters.productOriginal
    context.commit(types.CATALOG_RESET_PRODUCT, productOriginal)
  },
  /**
   * Setup product breadcrumbs path
   */
  async setupBreadcrumbs (context, { product }) {
    let breadcrumbsName = null
    let setBreadcrumbRoutesFromPath = (path) => {
      if (path.findIndex(itm => {
        return itm.slug === context.rootGetters['category/getCurrentCategory'].slug
      }) < 0) {
        path.push({
          url_path: context.rootGetters['category/getCurrentCategory'].url_path,
          slug: context.rootGetters['category/getCurrentCategory'].slug,
          name: context.rootGetters['category/getCurrentCategory'].name
        }) // current category at the end
      }
      // deprecated, TODO: base on breadcrumbs module
      breadcrumbsName = product.name
      const breadcrumbs = {
        routes: formatBreadCrumbRoutes(path),
        current: breadcrumbsName,
        name: breadcrumbsName
      }
      context.commit(types.CATALOG_SET_BREADCRUMBS, breadcrumbs)
    }

    if (product.category && product.category.length > 0) {
      const categoryIds = product.category.reverse().map(cat => cat.category_id)
      await context.dispatch('category/list', { key: 'id', value: categoryIds }, { root: true }).then(async (categories) => {
        const catList = []

        for (let catId of categoryIds) {
          let category = categories.items.find((itm) => { return toString(itm['id']) === toString(catId) })
          if (category) {
            catList.push(category)
          }
        }

        const rootCat = catList.shift()
        let catForBreadcrumbs = rootCat

        for (let cat of catList) {
          const catPath = cat.path
          if (catPath && catPath.includes(rootCat.path) && (catPath.split('/').length > catForBreadcrumbs.path.split('/').length)) {
            catForBreadcrumbs = cat
          }
        }
        if (typeof catForBreadcrumbs !== 'undefined') {
          await context.dispatch('category/single', { key: 'id', value: catForBreadcrumbs.id }, { root: true }).then(() => { // this sets up category path and current category
            setBreadcrumbRoutesFromPath(context.rootGetters['category/getCurrentCategoryPath'])
          }).catch(err => {
            setBreadcrumbRoutesFromPath(context.rootGetters['category/getCurrentCategoryPath'])
            Logger.error(err)()
          })
        } else {
          setBreadcrumbRoutesFromPath(context.rootGetters['category/getCurrentCategoryPath'])
        }
      })
    }
  },
  doPlatformPricesSync (context, { products }) {
    return doPlatformPricesSync(products)
  },
  /**
   * Download Magento2 / other platform prices to put them over ElasticSearch prices
   */
  syncPlatformPricesOver (context, { skus }) {
    const storeView = currentStoreView()
    return TaskQueue.execute({ url: config.products.endpoint + '/render-list?skus=' + encodeURIComponent(skus.join(',')) + '&currencyCode=' + encodeURIComponent(storeView.i18n.currencyCode) + '&storeId=' + encodeURIComponent(storeView.storeId), // sync the cart
      payload: {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors'
      },
      callback_event: 'prices-after-sync'
    }).then((task: any) => {
      return task.result
    })
  },
  /**
   * Setup associated products
   */
  setupAssociated (context, { product, skipCache = true }) {
    let subloaders = []
    if (product.type_id === 'grouped') {
      product.price = 0
      product.price_incl_tax = 0
      Logger.debug(product.name + ' SETUP ASSOCIATED', product.type_id)()
      if (product.product_links && product.product_links.length > 0) {
        for (let pl of product.product_links) {
          if (pl.link_type === 'associated' && pl.linked_product_type === 'simple') { // prefetch links
            Logger.debug('Prefetching grouped product link for ' + pl.sku + ' = ' + pl.linked_product_sku)()
            subloaders.push(context.dispatch('single', {
              options: { sku: pl.linked_product_sku },
              setCurrentProduct: false,
              selectDefaultVariant: false,
              skipCache: skipCache
            }).catch(err => { Logger.error(err) }).then((asocProd) => {
              if (asocProd) {
                pl.product = asocProd
                pl.product.qty = 1
                product.price += pl.product.price
                product.price_incl_tax += pl.product.price_incl_tax
                product.tax += pl.product.tax
              } else {
                Logger.error('Product link not found', pl.linked_product_sku)()
              }
            }))
          }
        }
      } else {
        Logger.error('Product with type grouped has no product_links set!', product)()
      }
    }
    if (product.type_id === 'bundle') {
      product.price = 0
      product.price_incl_tax = 0
      Logger.debug(product.name + ' SETUP ASSOCIATED', product.type_id)()
      if (product.bundle_options && product.bundle_options.length > 0) {
        for (let bo of product.bundle_options) {
          let defaultOption = bo.product_links.find((p) => { return p.is_default })
          if (!defaultOption) defaultOption = bo.product_links[0]
          for (let pl of bo.product_links) {
            Logger.debug('Prefetching bundle product link for ' + bo.sku + ' = ' + pl.sku)()
            subloaders.push(context.dispatch('single', {
              options: { sku: pl.sku },
              setCurrentProduct: false,
              selectDefaultVariant: false,
              skipCache: skipCache
            }).catch(err => { Logger.error(err) }).then((asocProd) => {
              if (asocProd) {
                pl.product = asocProd
                pl.product.qty = pl.qty

                if (pl.id === defaultOption.id) {
                  product.price += pl.product.price * pl.product.qty
                  product.price_incl_tax += pl.product.price_incl_tax * pl.product.qty
                  product.tax += pl.product.tax * pl.product.qty
                }
              } else {
                Logger.error('Product link not found', pl.sku)()
              }
            }))
          }
        }
      }
    }
    return Promise.all(subloaders)
  },
  /**
   * This is fix for https://github.com/DivanteLtd/vue-storefront/issues/508
   * TODO: probably it would be better to have "parent_id" for simple products or to just ensure configurable variants are not visible in categories/search
   */
  checkConfigurableParent (context, {product}) {
    if (product.type_id === 'simple') {
      Logger.log('Checking configurable parent')()

      let searchQuery = new SearchQuery()
      searchQuery = searchQuery.applyFilter({key: 'configurable_children.sku', value: {'eq': context.state.current.sku}})

      return context.dispatch('list', {query: searchQuery, start: 0, size: 1, updateState: false}).then((resp) => {
        if (resp.items.length >= 1) {
          const parentProduct = resp.items[0]
          context.commit(types.CATALOG_SET_PRODUCT_PARENT, parentProduct)
        }
      }).catch((err) => {
        Logger.error(err)()
      })
    }
  },
  /**
   * Load required configurable attributes
   * @param context
   * @param product
   */
  loadConfigurableAttributes (context, { product }) {
    let attributeKey = 'attribute_id'
    const configurableAttrKeys = product.configurable_options.map(opt => {
      if (opt.attribute_id) {
        attributeKey = 'attribute_id'
        return opt.attribute_id
      } else {
        attributeKey = 'attribute_code'
        return opt.attribute_code
      }
    })
    return context.dispatch('attribute/list', {
      filterValues: configurableAttrKeys,
      filterField: attributeKey
    }, { root: true })
  },
  /**
   * Setup product current variants
   */
  setupVariants (context, { product }) {
    let subloaders = []
    if (product.type_id === 'configurable' && product.hasOwnProperty('configurable_options')) {
      subloaders.push(context.dispatch('product/loadConfigurableAttributes', { product }, { root: true }).then((attributes) => {
        context.state.current_options = {
        }
        for (let option of product.configurable_options) {
          for (let ov of option.values) {
            let lb = ov.label ? ov.label : optionLabel(context.rootState.attribute, { attributeKey: option.attribute_id, searchBy: 'id', optionId: ov.value_index })
            if (trim(lb) !== '') {
              let optionKey = option.attribute_code ? option.attribute_code : option.label.toLowerCase()
              if (!context.state.current_options[optionKey]) {
                context.state.current_options[optionKey] = []
              }
              context.state.current_options[optionKey].push({
                label: lb,
                id: ov.value_index,
                attribute_code: option.attribute_code
              })
            }
          }
        }
        Vue.set(context.state, 'current_options', context.state.current_options)
        let selectedVariant = context.state.current
        populateProductConfigurationAsync(context, { selectedVariant: selectedVariant, product: product })
      }).catch(err => {
        Logger.error(err)()
      }))
    }
    return Promise.all(subloaders)
  },
  filterUnavailableVariants (context, { product }) {
    return filterOutUnavailableVariants(context, product)
  },

  /**
   * Search ElasticSearch catalog of products using simple text query
   * Use bodybuilder to build the query, aggregations etc: http://bodybuilder.js.org/
   * @param {Object} query is the object of searchQuery class
   * @param {Int} start start index
   * @param {Int} size page size
   * @return {Promise}
   */
  async list (context, { query, start = 0, size = 50, entityType = 'product', sort = '', cacheByKey = 'sku', prefetchGroupProducts = !isServer, updateState = false, meta = {}, excludeFields = null, includeFields = null, configuration = null, append = false, populateRequestCacheTags = true }) {
    const products = await context.dispatch('findProducts', { query, start, size, entityType, sort, cacheByKey, excludeFields, includeFields, configuration, populateRequestCacheTags })

    await context.dispatch('preConfigureAssociated', { products, prefetchGroupProducts })

    if (updateState) {
      context.commit(types.CATALOG_UPD_PRODUCTS, { products, append: append })
    }

    EventBus.$emit('product-after-list', { query: query, start: start, size: size, sort: sort, entityType: entityType, meta: meta, result: products })

    return products
  },
  preConfigureAssociated (context, { products, prefetchGroupProducts }) {
    for (let product of products.items) {
      if (product.url_path) {
        const { parentSku, slug } = product

        context.dispatch('url/registerMapping', {
          url: product.url_path,
          routeData: {
            params: { parentSku, slug },
            'name': product.type_id + '-product'
          }
        }, { root: true })
      }

      if (isGroupedOrBundle(product) && prefetchGroupProducts && !isServer) {
        context.dispatch('setupAssociated', { product })
      }
    }
  },
  preConfigureProduct (context, { product, populateRequestCacheTags, configuration }) {
    let prod = preConfigureProduct({ product, populateRequestCacheTags })

    if (configuration) {
      const selectedVariant = configureProductAsync(context, { product: prod, selectDefaultVariant: false, configuration })
      Object.assign(prod, omit(selectedVariant, ['visibility']))
    }

    return prod
  },
  async configureLoadedProducts (context, { products, isCacheable, cacheByKey, populateRequestCacheTags, configuration }) {
    if (products.items && products.items.length) { // preconfigure products; eg: after filters
      for (let product of products.items) {
        product = await context.dispatch('preConfigureProduct', { product, populateRequestCacheTags, configuration }) // preConfigure(product)
      }
    }

    await calculateTaxes(products, context)

    for (let prod of products.items) { // we store each product separately in cache to have offline access to products/single method
      prod = configureChildren(prod)

      if (isCacheable) { // store cache only for full loads
        storeProductToCache(prod, cacheByKey)
      }
    }

    return products
  },
  async findProducts (context, { query, start = 0, size = 50, entityType = 'product', sort = '', cacheByKey = 'sku', excludeFields = null, includeFields = null, configuration = null, populateRequestCacheTags = true }) {
    const isCacheable = canCache({ includeFields, excludeFields })
    const { excluded, included } = getOptimizedFields({ excludeFields, includeFields })
    const resp = await quickSearchByQuery({ query, start, size, entityType, sort, excludeFields: excluded, includeFields: included })
    const products = await context.dispatch('configureLoadedProducts', { products: resp, isCacheable, cacheByKey, populateRequestCacheTags, configuration })

    return products
  },
  async findConfigurableParent (context, { product, configuration }) {
    const searchQuery = new SearchQuery()
    const query = searchQuery.applyFilter({key: 'configurable_children.sku', value: { 'eq': product.sku }})
    const products = await context.dispatch('findProducts', { query, configuration })
    return products.items && products.items.length > 0 ? products.items[0] : null
  },
  /**
   * Update associated products for bundle product
   * @param context
   * @param product
   */
  configureBundleAsync (context, product) {
    return context.dispatch(
      'setupAssociated', {
        product: product,
        skipCache: true
      })
      .then(() => { context.dispatch('setCurrent', product) })
      .then(() => { EventBus.$emit('product-after-setup-associated') })
  },

  /**
   * Update associated products for group product
   * @param context
   * @param product
   */
  configureGroupedAsync (context, product) {
    return context.dispatch(
      'setupAssociated', {
        product: product,
        skipCache: true
      })
      .then(() => { context.dispatch('setCurrent', product) })
  },

  /**
   * Search products by specific field
   * @param {Object} options
   */
  async single (context, { options, setCurrentProduct = true, selectDefaultVariant = true, assignDefaultVariant = false, key = 'sku', skipCache = false }) {
    if (!options[key]) {
      throw Error('Please provide the search key ' + key + ' for product/single action!')
    }
    const cacheKey = entityKeyName(key, options[key])

    return new Promise((resolve, reject) => {
      const benchmarkTime = new Date()
      const cache = StorageManager.get('elasticCache')

      const setupProduct = (prod) => {
        // set product quantity to 1
        if (!prod.qty) {
          prod.qty = 1
        }
        // set original product
        if (setCurrentProduct) {
          context.dispatch('setOriginal', prod)
        }
        // check is prod has configurable children
        const hasConfigurableChildren = prod && prod.configurable_children && prod.configurable_children.length
        if (prod.type_id === 'simple' && hasConfigurableChildren) { // workaround for #983
          prod = omit(prod, ['configurable_children', 'configurable_options'])
        }

        // set current product - configurable or not
        if (prod.type_id === 'configurable' && hasConfigurableChildren) {
          // set first available configuration
          // todo: probably a good idea is to change this [0] to specific id
          const selectedVariant = configureProductAsync(context, { product: prod, configuration: { sku: options.childSku }, selectDefaultVariant: selectDefaultVariant, setProductErorrs: true })
          if (selectedVariant && assignDefaultVariant) {
            prod = Object.assign(prod, selectedVariant)
          }
        } else if (!skipCache || (prod.type_id === 'simple' || prod.type_id === 'downloadable')) {
          if (setCurrentProduct) context.dispatch('setCurrent', prod)
        }

        return prod
      }

      const syncProducts = () => {
        let searchQuery = new SearchQuery()
        searchQuery = searchQuery.applyFilter({key: key, value: {'eq': options[key]}})

        return context.dispatch('list', { // product list syncs the platform price on it's own
          query: searchQuery,
          prefetchGroupProducts: false,
          updateState: false
        }).then((res) => {
          if (res && res.items && res.items.length) {
            let prd = res.items[0]
            const _returnProductNoCacheHelper = (subresults) => {
              EventBus.$emitFilter('product-after-single', { key: key, options: options, product: prd })
              resolve(setupProduct(prd))
            }
            if (setCurrentProduct || selectDefaultVariant) {
              const subConfigPromises = []
              if (prd.type_id === 'bundle') {
                subConfigPromises.push(context.dispatch('configureBundleAsync', prd))
              }

              if (prd.type_id === 'grouped') {
                subConfigPromises.push(context.dispatch('configureGroupedAsync', prd))
              }
              subConfigPromises.push(context.dispatch('setupVariants', { product: prd }))
              Promise.all(subConfigPromises).then(_returnProductNoCacheHelper)
            } else {
              _returnProductNoCacheHelper(null)
            }
          } else {
            reject(new Error('Product query returned empty result'))
          }
        })
      }

      const getProductFromCache = () => {
        cache.getItem(cacheKey, (err, res) => {
          // report errors
          if (!skipCache && err) {
            Logger.error(err, 'product')()
          }

          if (res !== null) {
            Logger.debug('Product:single - result from localForage (for ' + cacheKey + '),  ms=' + (new Date().getTime() - benchmarkTime.getTime()), 'product')()
            const _returnProductFromCacheHelper = (subresults) => {
              const cachedProduct = setupProduct(res)
              if (config.products.alwaysSyncPlatformPricesOver) {
                doPlatformPricesSync([cachedProduct]).then((products) => {
                  EventBus.$emitFilter('product-after-single', { key: key, options: options, product: products[0] })
                  resolve(products[0])
                })
                if (!config.products.waitForPlatformSync) {
                  EventBus.$emitFilter('product-after-single', { key: key, options: options, product: cachedProduct })
                  resolve(cachedProduct)
                }
              } else {
                EventBus.$emitFilter('product-after-single', { key: key, options: options, product: cachedProduct })
                resolve(cachedProduct)
              }
            }
            if (setCurrentProduct || selectDefaultVariant) {
              const subConfigPromises = []
              subConfigPromises.push(context.dispatch('setupVariants', { product: res }))
              if (res.type_id === 'bundle') {
                subConfigPromises.push(context.dispatch('configureBundleAsync', res))
              }
              if (res.type_id === 'grouped') {
                subConfigPromises.push(context.dispatch('configureGroupedAsync', res))
              }
              Promise.all(subConfigPromises).then(_returnProductFromCacheHelper)
            } else {
              _returnProductFromCacheHelper(null)
            }
          } else {
            syncProducts()
          }
        })
      }

      if (!skipCache) {
        getProductFromCache()
      } else {
        if (!isOnline()) {
          skipCache = false;
        }

        syncProducts()
      }
    })
  },
  /**
   * Configure product with given configuration and set it as current
   * @param {Object} context
   * @param {Object} product
   * @param {Array} configuration
   */
  configure (context, { product = null, configuration, selectDefaultVariant = true, fallbackToDefaultWhenNoAvailable = true }) {
    return configureProductAsync(context, { product: product, configuration: configuration, selectDefaultVariant: selectDefaultVariant, fallbackToDefaultWhenNoAvailable: fallbackToDefaultWhenNoAvailable })
  },

  setCurrentOption (context, productOption) {
    if (productOption && typeof productOption === 'object') { // TODO: this causes some kind of recurrency error
      context.commit(types.CATALOG_SET_PRODUCT_CURRENT, Object.assign({}, context.state.current, { product_option: productOption }))
    }
  },

  setCurrentErrors (context, errors) {
    if (errors && typeof errors === 'object') {
      context.commit(types.CATALOG_SET_PRODUCT_CURRENT, Object.assign({}, context.state.current, { errors: errors }))
    }
  },
  /**
   * Assign the custom options object to the currentl product
   */
  setCustomOptions (context, { customOptions, product }) {
    if (customOptions) { // TODO: this causes some kind of recurrency error
      context.commit(types.CATALOG_SET_PRODUCT_CURRENT, Object.assign({}, product, { product_option: setCustomProductOptionsAsync(context, { product: context.state.current, customOptions: customOptions }) }))
    }
  },
  /**
   * Assign the bundle options object to the vurrent product
   */
  setBundleOptions (context, { bundleOptions, product }) {
    if (bundleOptions) { // TODO: this causes some kind of recurrency error
      context.commit(types.CATALOG_SET_PRODUCT_CURRENT, Object.assign({}, product, { product_option: setBundleProductOptionsAsync(context, { product: context.state.current, bundleOptions: bundleOptions }) }))
    }
  },
  /**
   * Set current product with given variant's properties
   * @param {Object} context
   * @param {Object} productVariant
   */
  setCurrent (context, productVariant) {
    if (productVariant && typeof productVariant === 'object') {
      // get original product
      const productOriginal = context.getters.productOriginal

      // check if passed variant is the same as original
      const productUpdated = Object.assign({}, productOriginal, productVariant)
      populateProductConfigurationAsync(context, { product: productUpdated, selectedVariant: productVariant })
      if (!config.products.gallery.mergeConfigurableChildren) {
        context.commit(types.CATALOG_UPD_GALLERY, attributeImages(productVariant))
      }
      context.commit(types.CATALOG_SET_PRODUCT_CURRENT, productUpdated)
      return productUpdated
    } else Logger.debug('Unable to update current product.', 'product')()
  },
  /**
   * Set given product as original
   * @param {Object} context
   * @param {Object} originalProduct
   */
  setOriginal (context, originalProduct) {
    if (originalProduct && typeof originalProduct === 'object') context.commit(types.CATALOG_SET_PRODUCT_ORIGINAL, originalProduct)
    else Logger.debug('Unable to setup original product.', 'product')()
  },
  /**
   * Set related products
   */
  related (context, { key = 'related-products', items }) {
    context.commit(types.CATALOG_UPD_RELATED, { key, items })
  },

  /**
   * Load the product data
   */
  fetch (context, { parentSku, childSku = null }) {
    // pass both id and sku to render a product
    const productSingleOptions = {
      sku: parentSku,
      childSku: childSku
    }
    return context.dispatch('single', { options: productSingleOptions }).then((product) => {
      if (product.status >= 2) {
        throw new Error(`Product query returned empty result product status = ${product.status}`)
      }
      if (product.visibility === 1) { // not visible individually (https://magento.stackexchange.com/questions/171584/magento-2-table-name-for-product-visibility)
        throw new Error(`Product query returned empty result product visibility = ${product.visibility}`)
      }

      let subloaders = []
      if (product) {
        const productFields = Object.keys(product).filter(fieldName => {
          return config.entities.product.standardSystemFields.indexOf(fieldName) < 0 // don't load metadata info for standard fields
        })
        const attributesPromise = context.dispatch('attribute/list', { // load attributes to be shown on the product details - the request is now async
          filterValues: config.entities.product.useDynamicAttributeLoader ? productFields : null,
          only_visible: config.entities.product.useDynamicAttributeLoader === true,
          only_user_defined: true,
          includeFields: config.entities.optimize ? config.entities.attribute.includeFields : null
        }, { root: true }) // TODO: it might be refactored to kind of: `await context.dispatch('attributes/list) - or using new Promise() .. to wait for attributes to be loaded before executing the next action. However it may decrease the performance - so for now we're just waiting with the breadcrumbs
        if (isServer) {
          subloaders.push(context.dispatch('setupBreadcrumbs', { product: product }))
          subloaders.push(context.dispatch('filterUnavailableVariants', { product: product }))
        } else {
          attributesPromise.then(() => context.dispatch('setupBreadcrumbs', { product: product })) // if this is client's side request postpone breadcrumbs setup till attributes are loaded to avoid too-early breadcrumb switch #2469
          context.dispatch('filterUnavailableVariants', { product: product }) // exec async
        }
        subloaders.push(attributesPromise)

        // subloaders.push(context.dispatch('setupVariants', { product: product })) -- moved to "product/single"
        /* if (product.type_id === 'grouped' || product.type_id === 'bundle') { -- moved to "product/single"
          subloaders.push(context.dispatch('setupAssociated', { product: product }).then((subloaderresults) => {
            context.dispatch('setCurrent', product) // because setup Associated can modify the product price we need to update the current product
          }))
        } */

        context.dispatch('setProductGallery', { product: product })

        if (config.products.preventConfigurableChildrenDirectAccess) {
          subloaders.push(context.dispatch('checkConfigurableParent', { product: product }))
        }
      } else { // error or redirect

      }
      return subloaders
    })
  },
  /**
   * Add custom option validator for product custom options
   */
  addCustomOptionValidator (context, { validationRule, validatorFunction }) {
    context.commit(types.CATALOG_ADD_CUSTOM_OPTION_VALIDATOR, { validationRule, validatorFunction })
  },

  /**
   * Set product gallery depending on product type
   */

  setProductGallery (context, { product }) {
    if (product.type_id === 'configurable' && product.hasOwnProperty('configurable_children')) {
      if (!config.products.gallery.mergeConfigurableChildren && product.is_configured) {
        context.commit(types.CATALOG_UPD_GALLERY, attributeImages(context.state.current))
      } else {
        let productGallery = uniqBy(configurableChildrenImages(product).concat(getMediaGallery(product)), 'src').filter(f => { return f.src && f.src !== config.images.productPlaceholder })
        context.commit(types.CATALOG_UPD_GALLERY, productGallery)
      }
    } else {
      let productGallery = uniqBy(configurableChildrenImages(product).concat(getMediaGallery(product)), 'src').filter(f => { return f.src && f.src !== config.images.productPlaceholder })
      context.commit(types.CATALOG_UPD_GALLERY, productGallery)
    }
  },

  /**
   * Load the product data - async version for asyncData()
   */
  // TODO refactor method like this to async/await for better readability
  fetchAsync (context, { parentSku, childSku = null, route = null }) {
    if (context.state.productLoadStart && (Date.now() - context.state.productLoadStart) < PRODUCT_REENTER_TIMEOUT) {
      Logger.log('Product is being fetched ...', 'product')()
    } else {
      context.state.productLoadPromise = new Promise((resolve, reject) => {
        context.state.productLoadStart = Date.now()
        Logger.info('Fetching product data asynchronously', 'product', {parentSku, childSku})()
        EventBus.$emit('product-before-load', { store: rootStore, route: route })
        context.dispatch('reset').then(() => {
          context.dispatch('fetch', { parentSku: parentSku, childSku: childSku }).then((subpromises) => {
            Promise.all(subpromises).then(subresults => {
              EventBus.$emitFilter('product-after-load', { store: rootStore, route: route }).then((results) => {
                context.state.productLoadStart = null
                return resolve()
              }).catch((err) => {
                context.state.productLoadStart = null
                Logger.error(err, 'product')()
                return resolve()
              })
            }).catch(errs => {
              context.state.productLoadStart = null
              reject(errs)
            })
          }).catch(err => {
            context.state.productLoadStart = null
            reject(err)
          }).catch(err => {
            context.state.productLoadStart = null
            reject(err)
          })
        })
      })
    }
    return context.state.productLoadPromise
  }
}

export default actions
