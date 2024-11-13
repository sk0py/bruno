import jsyaml from 'js-yaml';
import each from 'lodash/each';
import get from 'lodash/get';
import fileDialog from 'file-dialog';
import { flatten } from 'flat';
import { uuid } from 'utils/common';
import { BrunoError } from 'utils/common/error';
import { validateSchema, transformItemsInCollection, hydrateSeqInCollection } from './common';

const readFile = (files) => {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = (e) => {
      try {
        // try to load JSON
        const parsedData = JSON.parse(e.target.result);
        resolve(parsedData);
      } catch (jsonError) {
        // not a valid JSOn, try yaml
        try {
          const parsedData = jsyaml.load(e.target.result, { schema: jsyaml.CORE_SCHEMA });
          resolve(parsedData);
        } catch (yamlError) {
          console.error('Error parsing the file :', jsonError, yamlError);
          reject(new BrunoError('Import collection failed'));
        }
      }
    };
    fileReader.onerror = (err) => reject(err);
    fileReader.readAsText(files[0]);
  });
};

const parseGraphQL = (text) => {
  try {
    const graphql = JSON.parse(text);

    return {
      query: graphql.query,
      variables: JSON.stringify(graphql.variables, null, 2)
    };
  } catch (e) {
    return {
      query: '',
      variables: ''
    };
  }
};

const addSuffixToDuplicateName = (item, index, allItems) => {
  // Check if the request name already exist and if so add a number suffix
  const nameSuffix = allItems.reduce((nameSuffix, otherItem, otherIndex) => {
    if (otherItem.name === item.name && otherIndex < index) {
      nameSuffix++;
    }
    return nameSuffix;
  }, 0);
  return nameSuffix !== 0 ? `${item.name}_${nameSuffix}` : item.name;
};

const regexVariable = new RegExp('{{.*?}}', 'g');
const regexToRemove = new RegExp('(?:_\\.|[\\s\\]]+)', 'g');
const regexToUnderscore = new RegExp('[.\\[]', 'g');

const normalizeVariables = (value) => {
  value = value || '';
  const variables = value.match(regexVariable) || [];
  each(variables, (variable) => {
    value = value.replaceAll(variable, variable.replaceAll(regexToRemove, '').replaceAll(regexToUnderscore, '_'));
  });
  return value;
};

const transformInsomniaRequestItem = (request, index, allRequests) => {
  const name = addSuffixToDuplicateName(request, index, allRequests);

  const brunoRequestItem = {
    uid: uuid(),
    name,
    type: 'http-request',
    request: {
      url: normalizeVariables(request.url),
      method: request.method,
      auth: {
        mode: 'none',
        basic: null,
        bearer: null,
        digest: null
      },
      headers: [],
      params: [],
      body: {
        mode: 'none',
        json: null,
        text: null,
        xml: null,
        formUrlEncoded: [],
        multipartForm: []
      }
    }
  };

  each(request.headers, (header) => {
    brunoRequestItem.request.headers.push({
      uid: uuid(),
      name: header.name,
      value: normalizeVariables(header.value),
      description: header.description,
      enabled: !header.disabled
    });
  });

  each(request.parameters, (param) => {
    brunoRequestItem.request.params.push({
      uid: uuid(),
      name: param.name,
      value: normalizeVariables(param.value),
      description: param.description,
      type: 'query',
      enabled: !param.disabled
    });
  });

  each(request.pathParameters, (param) => {
    brunoRequestItem.request.params.push({
      uid: uuid(),
      name: param.name,
      value: param.value,
      description: '',
      type: 'path',
      enabled: true
    });
  });

  const authType = get(request, 'authentication.type', '');

  if (authType === 'basic') {
    brunoRequestItem.request.auth.mode = 'basic';
    brunoRequestItem.request.auth.basic = {
      username: normalizeVariables(get(request, 'authentication.username', '')),
      password: normalizeVariables(get(request, 'authentication.password', ''))
    };
  } else if (authType === 'bearer') {
    brunoRequestItem.request.auth.mode = 'bearer';
    brunoRequestItem.request.auth.bearer = {
      token: normalizeVariables(get(request, 'authentication.token', ''))
    };
  }

  const mimeType = get(request, 'body.mimeType', '').split(';')[0];

  if (mimeType === 'application/json') {
    brunoRequestItem.request.body.mode = 'json';
    brunoRequestItem.request.body.json = normalizeVariables(request.body.text);
  } else if (mimeType === 'application/x-www-form-urlencoded') {
    brunoRequestItem.request.body.mode = 'formUrlEncoded';
    each(request.body.params, (param) => {
      brunoRequestItem.request.body.formUrlEncoded.push({
        uid: uuid(),
        name: param.name,
        value: normalizeVariables(param.value),
        description: param.description,
        enabled: !param.disabled
      });
    });
  } else if (mimeType === 'multipart/form-data') {
    brunoRequestItem.request.body.mode = 'multipartForm';
    each(request.body.params, (param) => {
      brunoRequestItem.request.body.multipartForm.push({
        uid: uuid(),
        type: 'text',
        name: param.name,
        value: normalizeVariables(param.value),
        description: param.description,
        enabled: !param.disabled
      });
    });
  } else if (mimeType === 'text/plain') {
    brunoRequestItem.request.body.mode = 'text';
    brunoRequestItem.request.body.text = normalizeVariables(request.body.text);
  } else if (mimeType === 'text/xml' || mimeType === 'application/xml') {
    brunoRequestItem.request.body.mode = 'xml';
    brunoRequestItem.request.body.xml = normalizeVariables(request.body.text);
  } else if (mimeType === 'application/graphql') {
    brunoRequestItem.type = 'graphql-request';
    brunoRequestItem.request.body.mode = 'graphql';
    brunoRequestItem.request.body.graphql = parseGraphQL(normalizeVariables(request.body.text));
  }

  return brunoRequestItem;
};

const parseInsomniaCollection = (data) => {
  const brunoCollection = {
    name: '',
    uid: uuid(),
    version: '1',
    items: [],
    environments: []
  };

  return new Promise((resolve, reject) => {
    try {
      const insomniaExport = data;
      const insomniaResources = get(insomniaExport, 'resources', []);
      const insomniaCollection = insomniaResources.find((resource) => resource._type === 'workspace');

      if (!insomniaCollection) {
        reject(new BrunoError('Collection not found inside Insomnia export'));
      }

      brunoCollection.name = insomniaCollection.name;

      const requestsAndFolders =
        insomniaResources.filter((resource) => resource._type === 'request' || resource._type === 'request_group') ||
        [];

      const environments = insomniaResources.filter((resource) => resource._type === 'environment') || [];

      function createFolderStructure(resources, parentId = null) {
        const requestGroups =
          resources.filter((resource) => resource._type === 'request_group' && resource.parentId === parentId) || [];
        const requests = resources.filter((resource) => resource._type === 'request' && resource.parentId === parentId);

        const folders = requestGroups.map((folder, index, allFolder) => {
          const name = addSuffixToDuplicateName(folder, index, allFolder);
          const requests = resources.filter(
            (resource) => resource._type === 'request' && resource.parentId === folder._id
          );

          return {
            uid: uuid(),
            name,
            type: 'folder',
            items: createFolderStructure(resources, folder._id).concat(requests.map(transformInsomniaRequestItem))
          };
        });

        return folders.concat(requests.map(transformInsomniaRequestItem));
      }

      /**
       * Creates environments from the given resources.
       *
       * @param {Array} resources - The array of resources.
       * @param {string|null} [parentId=null] - The parent ID to filter environments.
       * @returns {Array} The array of created environments.
       */
      function createEnvironments(resources, parentId = null) {
        const environments = resources.filter(
          (resource) => resource._type === 'environment' && resource.parentId === parentId
        );

        return environments.reduce((result, environment) => {
          console.log('environment.data', environment.data);

          const variables = Object.entries(flatten(environment.data || {}, { delimiter: '_' })).map(([key, value]) => ({
            uid: uuid(),
            name: key,
            value: normalizeVariables(value.toString()),
            enabled: true,
            secret: false,
            type: 'text'
          }));

          const environmentResult = {
            uid: uuid(),
            name: environment.name,
            variables
          };

          return result.concat(environmentResult, createEnvironments(resources, environment._id));
        }, []);
      }

      brunoCollection.environments = createEnvironments(environments, insomniaCollection._id);

      (brunoCollection.items = createFolderStructure(requestsAndFolders, insomniaCollection._id)),
        resolve(brunoCollection);
    } catch (err) {
      reject(new BrunoError('An error occurred while parsing the Insomnia collection'));
    }
  });
};

const importCollection = () => {
  return new Promise((resolve, reject) => {
    fileDialog({ accept: '.json, .yaml, .yml, application/json, application/yaml, application/x-yaml' })
      .then(readFile)
      .then(parseInsomniaCollection)
      .then(transformItemsInCollection)
      .then(hydrateSeqInCollection)
      .then(validateSchema)
      .then((collection) => resolve({ collection }))
      .catch((err) => {
        console.error(err);
        reject(new BrunoError('Import collection failed: ' + err.message));
      });
  });
};

export default importCollection;
