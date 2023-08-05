import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CdkResourceInitializer } from './RDSInit';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class ExampleFargateStack extends cdk.Stack {
  private rdsServerlessCluster: {
    rdsPolicyStatement: iam.PolicyStatement;
    cluster: rds.ServerlessCluster;
    appSecret: secretsmanager.Secret;
  };
  private ECSCluster: {
    cluster: ecs.Cluster;
    kmsKey: kms.Key;
  };
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const name = 'hep3go';
    // base infrastucture
    const vpc = new ec2.Vpc(this, 'VPC', { maxAzs: 2 });

    this.createECSCluster(vpc);
    this.createServerlessRDS(vpc);

    // Create an ECR repository
    const ecrRepo = new ecr.Repository(this, `${name}_ecrRepo`, {
      repositoryName: `${name}_repo`,
    });
    const image = ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest');
    const koaService = this.runFargateContainer(
      'koa-test',
      vpc,
      this.ECSCluster.cluster,
      {
        secret: this.rdsServerlessCluster.appSecret,
        container: {
          image: image,
          secrets: {
            DB_CREDENTIALS: ecs.Secret.fromSecretsManager(
              this.rdsServerlessCluster.appSecret
            ),
          },
        },
      }
    );
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: 'ServicesLB',
    });
    new cdk.CfnOutput(this, 'ALB URL', {
      value: alb.loadBalancerDnsName,
    });

    // network the service with the load balancer
    const listener = alb.addListener('listener', {
      open: true,
      port: 80,
    });

    // add target group to container
    listener.addTargets('fargateService', {
      targetGroupName: 'fargateServiceTarget',
      port: 80,
      targets: [koaService],
    });
  }

  //FUNCTIONS

  addIngreesRuleToRDS(securityGroup: ec2.SecurityGroup) {
    this.rdsServerlessCluster.cluster.connections.securityGroups[0].addIngressRule(
      securityGroup,
      ec2.Port.tcp(5432)
    );
  }

  createServerlessRDS(vpc: ec2.Vpc) {
    const rdsCluster = new rds.ServerlessCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
      parameterGroup: new rds.ParameterGroup(this, 'default', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_13_9,
        }),
      }),
      defaultDatabaseName: 'MyDatabase',
      vpc,
      scaling: {
        autoPause: cdk.Duration.minutes(5),
        minCapacity: rds.AuroraCapacityUnit.ACU_2,
        maxCapacity: rds.AuroraCapacityUnit.ACU_2,
      },
    });

    const rdsAdminSecret = rdsCluster.secret;
    if (rdsAdminSecret == undefined) {
      throw new ReferenceError('rdsAdminSecret is undefined');
    }

    const adminDBPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [rdsAdminSecret.secretArn],
    });

    const rdsAppSecret = new secretsmanager.Secret(
      this,
      'rdsAppCredentials',
      {}
    );
    const appDBPolicy = new iam.PolicyStatement({
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
      ],
      resources: [rdsAppSecret.secretArn],
    });
    this.rdsServerlessCluster = {
      cluster: rdsCluster,
      rdsPolicyStatement: new iam.PolicyStatement({
        actions: ['rds:*'],
        resources: [rdsCluster.clusterArn],
      }),
      appSecret: rdsAppSecret,
    };
    const initializer = new CdkResourceInitializer(this, 'Initializer', {
      vpc: vpc,
      policies: [
        appDBPolicy,
        adminDBPolicy,
        this.rdsServerlessCluster.rdsPolicyStatement,
      ],
      config: {
        credsSecretName: rdsAdminSecret.secretName,
        dbSecretName: rdsAppSecret.secretName,
      },
    });
    this.addIngreesRuleToRDS(initializer.functionSG);
  }

  createECSTaskRole(name: string): iam.Role {
    const taskRole = new iam.Role(this, `${name}-taskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(this.rdsServerlessCluster.rdsPolicyStatement);
    return taskRole;
  }

  createECSCluster(vpc: ec2.Vpc) {
    const kmsKey = new kms.Key(this, 'ECSExecKmsKey', {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const execBucket = new s3.Bucket(this, 'ECSExecBucket', {
      encryptionKey: kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const execDep = {
      kmsKey: kmsKey,
      execBucket: execBucket,
    };

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'Services',
      vpc: vpc,
      containerInsights: true,
      executeCommandConfiguration: {
        kmsKey: kmsKey,
        logConfiguration: {
          s3Bucket: execBucket,
          s3EncryptionEnabled: true,
          s3KeyPrefix: 'exec-command-output',
        },
        logging: ecs.ExecuteCommandLogging.OVERRIDE,
      },
    });
    this.ECSCluster = {
      cluster: cluster,
      kmsKey: kmsKey,
    };
  }

  runFargateContainer(
    name: string,
    vpc: ec2.Vpc,
    cluster: ecs.Cluster,
    containerDef: {
      secret: secretsmanager.Secret;
      container: ecs.ContainerDefinitionOptions;
    }
  ): ecs.FargateService {
    const taskRole = this.createECSTaskRole(name);

    const fargateAppTaskDef = new ecs.FargateTaskDefinition(
      this,
      `${name}-TaskDef`,
      {
        taskRole,
      }
    );
    fargateAppTaskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [containerDef.secret.secretArn],
      })
    );
    fargateAppTaskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      })
    );

    fargateAppTaskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt'],
        resources: [this.ECSCluster.kmsKey.keyArn],
      })
    );

    const fargateContainer = fargateAppTaskDef.addContainer(
      `${name}-Container`,
      containerDef.container
    );
    fargateContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // Security Group for the Fargate Service
    const fargateServiceSecurityGroup = new ec2.SecurityGroup(
      this,
      `${name}-SecurityGroup`,
      { vpc }
    );
    this.addIngreesRuleToRDS(fargateServiceSecurityGroup);
    // Fargate Service
    const fargateService = new ecs.FargateService(this, `${name}-Service`, {
      cluster: cluster,
      taskDefinition: fargateAppTaskDef,
      serviceName: `${name}-Service`,
      enableExecuteCommand: true,
      assignPublicIp: true,
      securityGroups: [fargateServiceSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    return fargateService;
  }
}
