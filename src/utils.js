const https = require("https");
const AWS = require("@serverless/aws-sdk-extra");
const { equals, not, pick } = require("ramda");
const { readFile } = require("fs-extra");

const agent = new https.Agent({ keepAlive: true });

/**
 * Sleep
 * @param {*} wait
 */
const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait));

/**
 * Generate a random ID
 */
const randomId = Math.random()
  .toString(36)
  .substring(6);

/**
 * Get AWS SDK Clients
 * @param {*} credentials
 * @param {*} region
 */
const getClients = (credentials = {}, region) => {
  AWS.config.update({ httpOptions: { agent } });

  return {
    extras: new AWS.Extras({ credentials, region }),
    iam: new AWS.IAM({ credentials, region }),
    lambda: new AWS.Lambda({ credentials, region }),
    sts: new AWS.STS({ credentials, region }),
  };
};

/**
 * Prepare inputs
 * @param {*} inputs
 * @param {*} instance
 */
const prepareInputs = (
  {
    alias: { name: aliasName = "provisioned" } = {},
    assumeRolePolicy,
    description,
    env = {},
    handler = "handler.handler",
    layers = [],
    memory = 1028,
    name,
    provisionedConcurrency = 0,
    region = "us-east-1",
    retry = 0,
    roleName,
    runtime = "nodejs12.x",
    src = null,
    timeout = 10,
    vpcConfig: { securityGroupIds = [], subnetIds = [] } = {},
  },
  instance,
) => ({
  aliasName,
  assumeRolePolicy,
  description: description || `Serverless Component: aws-lambda. Name: "${instance.name}" Stage: "${instance.stage}"`,
  env,
  handler,
  layers,
  memory,
  name: name || instance.state.name || `${instance.name}-${instance.stage}-${randomId}`,
  provisionedConcurrency,
  region,
  retry,
  roleName,
  runtime,
  securityGroupIds,
  src,
  subnetIds,
  timeout,
});

/*
 * Ensure the provided IAM Role or default IAM Role exists
 *
 * @param ${instance} instance - the component instance
 * @param ${object} inputs - the component inputs
 * @param ${object} clients - the aws clients object
 */
const createOrUpdateFunctionRole = async ({ state }, { name, assumeRolePolicy, roleName }, clients) => {
  // Verify existing role, either provided or the previously created default role...
  if (roleName) {
    console.log(`Verifying the provided IAM Role with the name: ${roleName} in the inputs exists...`);

    const userRole = await clients.extras.getRole({ roleName });
    const userRoleArn = userRole && userRole.Role && userRole.Role.Arn ? userRole.Role.Arn : null; // Don't save user provided role to state, always reference it as an input, in case it changes

    // If user role exists, save it to state so it can be used for the create/update lambda logic later
    if (userRoleArn) {
      console.log(`The provided IAM Role with the name: ${roleName} in the inputs exists.`);
      state.userRoleArn = userRoleArn;

      // Save AWS Account ID by fetching the role ID
      // TODO: This may not work with cross-account roles.
      state.awsAccountId = state.userRoleArn.split(":")[4];

      // Be sure to delete defaultLambdaRoleArn data, if it exists
      if (state.defaultLambdaRoleArn) {
        delete state.defaultLambdaRoleArn;
      }
    } else {
      throw new Error(`The provided IAM Role with the name: ${roleName} could not be found.`);
    }
  } else {
    // Create a default role with basic Lambda permissions

    const defaultLambdaRoleName = `${name}-lambda-role`;
    console.log(`IAM Role not found.  Creating or updating a default role with the name: ${defaultLambdaRoleName}`);

    const result = await clients.extras.deployRole({
      roleName: defaultLambdaRoleName,
      service: ["lambda.amazonaws.com"],
      policy: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
      // todo; add inline policy for VPC, such as CreateNetworkInterface... etc.
      assumeRolePolicyDocument: assumeRolePolicy && {
        Version: "2012-10-17",
        Statement: assumeRolePolicy,
      },
    });

    state.defaultLambdaRoleName = defaultLambdaRoleName;
    state.defaultLambdaRoleArn = result.roleArn;
    state.awsAccountId = state.defaultLambdaRoleArn.split(":")[4];

    // Be sure to delete userRole data, if it exists
    if (state.userRoleArn) {
      delete state.userRoleArn;
    }

    console.log(`Default Lambda IAM Role created or updated with ARN ${state.defaultLambdaRoleArn}`);
  }
};

/*
 * Ensure the Meta IAM Role exists
 */
const createOrUpdateMetaRole = async ({ name, stage, state }, { monitoring = true }, clients, serverlessAccountId) => {
  // Create or update Meta Role for monitoring and more, if option is enabled.  It's enabled by default.
  if (!monitoring) {
    return;
  }

  console.log("Creating or updating the meta IAM Role...");

  const roleName = `${name}-meta-role`;

  const assumeRolePolicyDocument = {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${serverlessAccountId}:root`, // Serverless's Components account
      },
      Action: "sts:AssumeRole",
    },
  };

  // Create a policy that only can access APIGateway and Lambda metrics, logs from CloudWatch...
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Resource: "*",
        Action: [
          "cloudwatch:Describe*",
          "cloudwatch:Get*",
          "cloudwatch:List*",
          "logs:Get*",
          "logs:List*",
          "logs:Describe*",
          "logs:TestMetricFilter",
          "logs:FilterLogEvents",
        ],
        // TODO: Finish this.  Haven't been able to get this to work.  Perhaps there is a missing service (Cloudfront?)
        // Condition: {
        //   StringEquals: {
        //     'cloudwatch:namespace': [
        //       'AWS/ApiGateway',
        //       'AWS/Lambda'
        //     ]
        //   }
        // }
      },
    ],
  };

  const result = await clients.extras.deployRole({
    assumeRolePolicyDocument,
    policy,
    roleDescription: `The Meta Role for the Serverless Framework App: ${name} Stage: ${stage}`,
    roleName,
  });

  state.metaRoleName = roleName;
  state.metaRoleArn = result.roleArn;

  console.log(`Meta IAM Role created or updated with ARN ${state.metaRoleArn}`);
};

/**
 * Create a new lambda function
 * @param {*} lambda
 * @param {*} config
 */
const createLambdaFunction = async (instance, lambda, inputs) => {
  const params = {
    FunctionName: inputs.name,
    Code: { ZipFile: await readFile(inputs.src) },
    Description: inputs.description,
    Handler: inputs.handler,
    MemorySize: inputs.memory,
    Publish: true,
    Role: instance.state.userRoleArn || instance.state.defaultLambdaRoleArn,
    Runtime: inputs.runtime,
    Timeout: inputs.timeout,
    Layers: inputs.layers,
    Environment: {
      Variables: inputs.env,
    },
    VpcConfig: {
      SecurityGroupIds: inputs.securityGroupIds,
      SubnetIds: inputs.subnetIds,
    },
  };

  try {
    const res = await lambda.createFunction(params).promise();
    return { arn: res.FunctionArn, hash: res.CodeSha256, version: res.Version };
  } catch (e) {
    if (e.message.includes(`The role defined for the function cannot be assumed by Lambda`)) {
      // we need to wait after the role is created before it can be assumed
      await sleep(5000);
      return await createLambdaFunction(instance, lambda, inputs);
    }
    throw e;
  }
};

/**
 * Update Lambda configuration
 * @param {*} lambda
 * @param {*} config
 */
const updateLambdaFunctionConfig = async (
  { state: { defaultLambdaRoleArn, userRoleArn = defaultLambdaRoleArn } },
  lambda,
  { name, description, handler, memory, timeout, retry, runtime, layers, env, securityGroupIds, subnetIds },
) => {
  const functionConfigParams = {
    FunctionName: name,
    Description: description,
    Handler: handler,
    MemorySize: memory,
    Role: userRoleArn,
    Runtime: runtime,
    Timeout: timeout,
    Layers: layers,
    Environment: { Variables: env },
    VpcConfig: {
      SecurityGroupIds: securityGroupIds,
      SubnetIds: subnetIds,
    },
  };

  const res = await lambda.updateFunctionConfiguration(functionConfigParams).promise();

  // update retry config
  await lambda
    .putFunctionEventInvokeConfig({
      FunctionName: name,
      MaximumRetryAttempts: retry,
    })
    .promise();

  return { arn: res.FunctionArn, hash: res.CodeSha256 };
};

/**
 * Update Lambda function code
 * @param {*} lambda
 * @param {*} config
 */
const updateLambdaFunctionCode = async (lambda, { name, src }) => {
  const functionCodeParams = {
    FunctionName: name,
    Publish: true,
    ZipFile: await readFile(src),
  };

  const res = await lambda.updateFunctionCode(functionCodeParams).promise();

  return { arn: res.FunctionArn, hash: res.CodeSha256, version: res.Version };
};

/**
 * Get Lambda Alias
 * @param {*} lambda
 * @param {*} inputs
 */
const getLambdaAlias = async (lambda, { aliasName, name }) => {
  try {
    const res = await lambda.getAlias({ FunctionName: name, Name: aliasName }).promise();

    return {
      name: res.Name,
      description: res.Description,
      arn: res.AliasArn,
      resourceId: res.ResourceId,
      routingConfig: res.RoutingConfig,
    };
  } catch (e) {
    if (e.code === "ResourceNotFoundException") {
      return null;
    }
    throw e;
  }
};

/**
 * Create a Lambda Alias
 * @param {*} lambda
 * @param {*} inputs
 */
const createLambdaAlias = async (lambda, { aliasName, name, version }) => {
  const params = {
    FunctionName: name,
    FunctionVersion: version,
    Name: aliasName,
  };

  const res = await lambda.createAlias(params).promise();

  return { name: res.Name, arn: res.AliasArn };
};

/**
 * Update a Lambda Alias
 * @param {*} lambda
 * @param {*} inputs
 */
const updateLambdaAlias = async (lambda, { aliasName, name, version }) => {
  const params = {
    FunctionName: name,
    FunctionVersion: version,
    Name: aliasName,
  };

  const res = await lambda.updateAlias(params).promise();

  return { name: res.Name, arn: res.AliasArn };
};

/**
 * Delete Lambda Alias, provisioned concurrency settings will be deleted together
 * @param {*} lambda
 * @param {*} inputs
 */
const deleteLambdaAlias = async (lambda, { aliasName, name }) => {
  const params = {
    FunctionName: name,
    Name: aliasName,
  };

  const res = await lambda.deleteAlias(params).promise();

  return { name: res.Name, arn: res.AliasArn };
};

/**
 * Update provisioned concurrency configurations
 * @param {*} lambda
 * @param {*} inputs
 */
const updateProvisionedConcurrencyConfig = async (lambda, { aliasName, name, provisionedConcurrency }) => {
  const params = {
    FunctionName: name,
    ProvisionedConcurrentExecutions: provisionedConcurrency,
    Qualifier: aliasName,
  };

  const res = await lambda.putProvisionedConcurrencyConfig(params).promise();

  return {
    allocated: res.AllocatedProvisionedConcurrentExecutions,
    requested: res.RequestedProvisionedConcurrentExecutions,
  };
};

/**
 * Get Lambda Function
 * @param {*} lambda
 * @param {*} functionName
 */
const getLambdaFunction = async (lambda, FunctionName) => {
  try {
    const res = await lambda.getFunctionConfiguration({ FunctionName }).promise();

    return {
      name: res.FunctionName,
      description: res.Description,
      timeout: res.Timeout,
      runtime: res.Runtime,
      role: { arn: res.Role },
      handler: res.Handler,
      memory: res.MemorySize,
      hash: res.CodeSha256,
      env: res.Environment ? res.Environment.Variables : {},
      arn: res.FunctionArn,
      securityGroupIds: res.VpcConfig ? res.VpcConfig.SecurityGroupIds : [],
      subnetIds: res.VpcConfig ? res.VpcConfig.SubnetIds : [],
    };
  } catch (e) {
    if (e.code === "ResourceNotFoundException") {
      return null;
    }
    throw e;
  }
};

/**
 * Delete Lambda function
 * @param {*} param0
 */
const deleteLambdaFunction = async (lambda, FunctionName) => {
  try {
    await lambda.deleteFunction({ FunctionName }).promise();
  } catch (error) {
    console.log(error);
    if (error.code !== "ResourceNotFoundException") {
      throw error;
    }
  }
};

/**
 * Get AWS IAM role policy
 * @param {*} param0
 */
const getPolicy = async ({ name, region, accountId }) => {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream"],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${name}:*`],
        Effect: "Allow",
      },
      {
        Action: ["logs:PutLogEvents"],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${name}:*:*`],
        Effect: "Allow",
      },
    ],
  };
};

/**
 * Detect if inputs have changed
 * @param {*} prevLambda
 * @param {*} lambda
 */
const inputsChanged = (prevLambda, lambda) => {
  const keys = [
    "description",
    "runtime",
    "roleArn",
    "handler",
    "memory",
    "timeout",
    "env",
    "hash",
    "securityGroupIds",
    "subnetIds",
    "provisionedConcurrency",
  ];
  const inputs = pick(keys, lambda);
  const prevInputs = pick(keys, prevLambda);
  return not(equals(inputs, prevInputs));
};

/*
 * Removes the Function & Meta Roles from aws according to the provided config
 *
 * @param ${object} clients - an object containing aws sdk clients
 * @param ${object} config - the component config
 */
const removeAllRoles = async ({ state }, clients) => {
  // Delete Function Role
  if (state.defaultLambdaRoleName) {
    console.log("Deleting the default Function Role...");
    await clients.extras.removeRole({
      roleName: state.defaultLambdaRoleName,
    });
  }

  // Delete Meta Role
  if (state.metaRoleName) {
    console.log("Deleting the Meta Role...");
    await clients.extras.removeRole({
      roleName: state.metaRoleName,
    });
  }
};

/**
 * Get metrics from cloudwatch
 * @param {*} clients
 * @param {*} rangeStart MUST be a moment() object
 * @param {*} rangeEnd MUST be a moment() object
 */
const getMetrics = async (region, metaRoleArn, functionName, rangeStart, rangeEnd) => {
  /**
   * Create AWS STS Token via the meta role that is deployed with the Express Component
   */

  // Assume Role
  const assumeParams = {
    DurationSeconds: 900,
    RoleArn: metaRoleArn,
    RoleSessionName: `session${Date.now()}`,
  };

  const sts = new AWS.STS({ region });
  const { Credentials: { AccessKeyId, SecretAccessKey, SessionToken } = {} } = await sts
    .assumeRole(assumeParams)
    .promise();

  /**
   * Instantiate a new Extras instance w/ the temporary credentials
   */

  const extras = new AWS.Extras({
    credentials: { AccessKeyId, SecretAccessKey, SessionToken },
    region,
  });

  const resources = [
    {
      type: "aws_lambda",
      functionName,
    },
  ];

  return await extras.getMetrics({
    rangeStart,
    rangeEnd,
    resources,
  });
};

/**
 * Exports
 */
module.exports = {
  prepareInputs,
  getClients,
  createOrUpdateFunctionRole,
  createOrUpdateMetaRole,
  createLambdaFunction,
  updateLambdaFunctionCode,
  updateLambdaFunctionConfig,
  getLambdaFunction,
  getLambdaAlias,
  createLambdaAlias,
  updateLambdaAlias,
  deleteLambdaAlias,
  updateProvisionedConcurrencyConfig,
  inputsChanged,
  deleteLambdaFunction,
  removeAllRoles,
  getMetrics,
};
