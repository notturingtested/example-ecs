import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  AwsSdkCall,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { createHash } from 'crypto';

export interface CdkResourceInitializerProps {
  vpc: ec2.IVpc;
  policies: iam.PolicyStatement[];
  config: { credsSecretName: string; dbSecretName: string };
}

export class CdkResourceInitializer extends Construct {
  public readonly response: string;
  public readonly customResource: AwsCustomResource;
  public readonly function: lambda.Function;
  public readonly functionSG: ec2.SecurityGroup;

  constructor(
    scope: Construct,
    id: string,
    props: CdkResourceInitializerProps
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const fnSg = new ec2.SecurityGroup(this, 'ResourceInitializerFnSg', {
      securityGroupName: `${id}ResourceInitializerFnSg`,
      vpc: props.vpc,
      allowAllOutbound: true,
    });
    this.functionSG = fnSg;
    const role = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const logPolicy = new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['arn:aws:logs:*:*:*'],
    });

    role.addToPolicy(logPolicy);
    const vpcAccessPolicyStatement = new iam.PolicyStatement({
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    });
    role.addToPolicy(vpcAccessPolicyStatement);

    for (const policy of props.policies) {
      role.addToPolicy(policy);
    }
    const fn = new lambda.Function(this, 'ResourceInitializerFn', {
      runtime: lambda.Runtime.NODEJS_14_X,
      memorySize: 128,
      functionName: `${id}-ResInit${stack.stackName}`,
      code: lambda.Code.fromAsset('lambdas/rds-init'), // code directory
      handler: 'index.handler',
      vpc: props.vpc,
      securityGroups: [fnSg],
      role: role,
      timeout: Duration.seconds(30),
      allowAllOutbound: true,
    });

    const payload: string = JSON.stringify({
      params: {
        config: props.config,
      },
    });

    const payloadHashPrefix = createHash('md5')
      .update(payload)
      .digest('hex')
      .substring(0, 6);

    const sdkCall: AwsSdkCall = {
      service: 'Lambda',
      action: 'invoke',
      parameters: {
        FunctionName: fn.functionName,
        Payload: payload,
      },
      physicalResourceId: PhysicalResourceId.of(
        `${id}-AwsSdkCall-${fn.currentVersion.version + payloadHashPrefix}`
      ),
    };

    const customResourceFnRole = new Role(this, 'AwsCustomResourceRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    customResourceFnRole.addToPolicy(
      new PolicyStatement({
        resources: [
          `arn:aws:lambda:${stack.region}:${stack.account}:function:*-ResInit${stack.stackName}`,
        ],
        actions: ['lambda:InvokeFunction'],
      })
    );
    this.customResource = new AwsCustomResource(this, 'AwsCustomResource', {
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      onUpdate: sdkCall,
      timeout: Duration.minutes(10),
      role: customResourceFnRole,
    });

    this.response = this.customResource.getResponseField('Payload');

    this.function = fn;
  }
}
