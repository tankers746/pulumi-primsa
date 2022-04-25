import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

// Import our Pulumi configuration.
const config = new pulumi.Config();
const dbName = config.require("db_name");
const dbUsername = config.require("db_username");
const dbPassword = config.require("db_password");

// Get the default VPC and ECS Cluster for your account.
const vpc = new awsx.ec2.Vpc("custom", {});

const rdsSecurityGroup = new aws.ec2.SecurityGroup(`dbsecgrp`, {
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 1433,
      toPort: 1433,
      cidrBlocks: [vpc.vpc.cidrBlock],
    },
  ],
});

const dbSubnets = new aws.rds.SubnetGroup("dbsubnets", {
  subnetIds: vpc.privateSubnetIds,
});

// Create a new database, using the subnet and cluster groups.
const db = new aws.rds.Instance("database", {
  engine: "postgres",
  instanceClass: aws.rds.InstanceTypes.T3_Micro,
  allocatedStorage: 5,
  dbSubnetGroupName: dbSubnets.id,
  vpcSecurityGroupIds: [rdsSecurityGroup.id],
  name: dbName,
  username: dbUsername,
  password: dbPassword,
  skipFinalSnapshot: true,
});

// Assemble a connection string for the Miniflux service.
const connectionString = pulumi.interpolate`postgres://${dbUsername}:${dbPassword}@${db.endpoint}/${dbName}?sslmode=disable`;

const webAppDeployBucket = new aws.s3.Bucket("web-app-deploy", {});

const webAppDeployObject = new aws.s3.BucketObject("default", {
  bucket: webAppDeployBucket.id,
  key: "deployment.zip",
  source: new pulumi.asset.FileAsset("./app/deployment.zip"),
});

const instanceProfileRole = new aws.iam.Role("eb-ec2-role", {
  name: "eb-ec2-role",
  description: "Role for EC2 managed by EB",
  assumeRolePolicy: pulumi.interpolate`{
          "Version": "2012-10-17",
          "Statement": [
              {
                  "Action": "sts:AssumeRole",
                  "Principal": {
                      "Service": "ec2.amazonaws.com"
                  },
                  "Effect": "Allow",
                  "Sid": ""
              }
          ]
      }`,
});

const instanceProfile = new aws.iam.InstanceProfile("eb-ec2-instance-profile", {
  role: instanceProfileRole.name,
});

const app = new aws.elasticbeanstalk.Application("webapp", {
  name: "webapp",
});

const defaultApplicationVersion = new aws.elasticbeanstalk.ApplicationVersion(
  "default",
  {
    application: app,
    bucket: webAppDeployBucket.id,
    description: "Version 0.1",
    key: webAppDeployObject.id,
  }
);

const tfenvtest = new aws.elasticbeanstalk.Environment("tfenvtest", {
  application: app,
  version: defaultApplicationVersion,
  solutionStackName:
    "64bit Amazon Linux 2018.03 v2.17.7 running Docker 20.10.7-ce",
  settings: [
    {
      namespace: "aws:ec2:vpc",
      name: "VPCId",
      value: vpc.id,
    },
    {
      namespace: "aws:ec2:vpc",
      name: "Subnets",
      value: pulumi.output(vpc.publicSubnetIds).apply((ids) => ids[0]),
    },
    {
      name: "IamInstanceProfile",
      namespace: "aws:autoscaling:launchconfiguration",
      value: instanceProfile.name,
    },
    {
      name: "DATABASE_URL",
      namespace: "aws:elasticbeanstalk:application:environment",
      value: connectionString,
    },
    {
      name: "SecurityGroups",
      namespace: "aws:autoscaling:launchconfiguration",
      value: rdsSecurityGroup.id,
    },
  ],
});

// Export the publicly accessible URL.
export const url = tfenvtest.endpointUrl;
