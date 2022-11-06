import { Construct } from 'constructs'
import { Arn, ArnFormat, Aws } from 'aws-cdk-lib'
import { Pipeline } from 'aws-cdk-lib/aws-codepipeline'
import { BuildSpec, LinuxBuildImage, Project } from 'aws-cdk-lib/aws-codebuild'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import {
  IntegrationPattern,
  JsonPath,
  Map,
  StateMachine,
} from 'aws-cdk-lib/aws-stepfunctions'
import {
  CallAwsService,
  CodeBuildStartBuild,
  StepFunctionsStartExecution,
} from 'aws-cdk-lib/aws-stepfunctions-tasks'
import {
  NestedStackBase,
  NestedStackBaseProps,
} from '../../lib/nested-stack-base'
import { deterministicName, regionToCode } from '../../lib/utils'
import { DeployerGlbStageProps } from './deployer-glb-config'
import { StateStack } from './state-stack'

export interface DeployerGlStackProps extends NestedStackBaseProps {
  readonly stateStack: StateStack
}

export class DeployerGlbStack extends NestedStackBase {
  readonly config: DeployerGlbStageProps
  readonly stateStack: StateStack
  readonly githubOidcProviderArn: string
  readonly codePipelines: Pipeline[] = []
  appDeployerStateMachine: StateMachine
  deployerStateMachine: StateMachine
  startBuildTask: CodeBuildStartBuild
  codeBuildRoPrj: Project
  codeBuildRwPrj: Project

  constructor(scope: Construct, id: string, props: DeployerGlStackProps) {
    super(scope, id, props)
    this.stateStack = props.stateStack

    this.initCodeBuildRoPrj()
    this.initCodeBuildRwPrj()
    this.initAppDeployerStateMachine()
    this.initDeployerStateMachine()
  }

  /**
   * Assemble deployer codebuild project environment variables for a given app
   * @param props Input props overrides
   * @returns Environment vars configuration object
   */
  private deployerEnvVars(props?: { app?: string; regcode?: string }): {
    DEPLOYER_IMAGE: { value: string }
    STAGE: { value: string }
    VERSION: { value: string }
    CMD: { value: string }
    APP: { value: string }
    REGCODE: { value: string }
  } {
    return {
      DEPLOYER_IMAGE: {
        value: this.stateStack.deployerEcrRepo.repositoryUri,
      },
      STAGE: {
        value: this.config.stageName,
      },
      VERSION: {
        value: JsonPath.stringAt('$.version'),
      },
      CMD: {
        value: JsonPath.stringAt('$.cmd'),
      },
      APP: {
        value: props?.app || JsonPath.stringAt('$.app'),
      },
      REGCODE: {
        value: props?.regcode || JsonPath.stringAt('$.regcode'),
      },
    }
  }

  private initDeployerStateMachine() {
    // make sure deployer image of given version is available
    const deployerImageAvailabilityTask = new CallAwsService(
      this,
      'DeployerImageAvailabilityTask',
      {
        service: 'ecr',
        action: 'batchGetImage',
        iamResources: [this.stateStack.deployerEcrRepo.repositoryArn],
        resultPath: JsonPath.DISCARD,
        parameters: {
          RepositoryName: this.stateStack.deployerEcrRepo.repositoryName,
          ImageIds: [
            {
              'ImageTag.$': `$.version`,
            },
          ],
        },
      }
    )

    // start deployer in codebuild with env vars mapped from task input
    const deployDeployerTask = new CodeBuildStartBuild(
      this,
      'DeployDeployerTask',
      {
        project: this.codeBuildRoPrj,
        integrationPattern: IntegrationPattern.RUN_JOB,
        resultPath: JsonPath.DISCARD,
        environmentVariablesOverride: this.deployerEnvVars({
          app: this.config.appName,
          // assuming single deployer region
          regcode: regionToCode(this.config.regions[0]),
        }),
      }
    )

    // start deployer in codebuild with env vars mapped from task input
    const deployAppsTask = new StepFunctionsStartExecution(
      this,
      'DeployAppsTask',
      {
        stateMachine: this.appDeployerStateMachine,
        integrationPattern: IntegrationPattern.RUN_JOB,
      }
    )

    const definition = deployerImageAvailabilityTask.next(
      deployDeployerTask.next(deployAppsTask)
    )

    this.deployerStateMachine = new StateMachine(this, 'DeployerStateMachine', {
      stateMachineName: deterministicName(
        { name: 'Deployer', region: null, app: null },
        this
      ),
      definition,
    })

    this.stateStack.deployerEcrRepo.grantPull(this.deployerStateMachine)
  }

  private initAppDeployerStateMachine() {
    // app deployment groups are deployed in sequence
    const appsGroupsMapTask = new Map(this, 'AppGroupsMapTask', {
      maxConcurrency: 1,
      // inputPath: JsonPath.stringAt('$.appGroups'),
      itemsPath: JsonPath.stringAt('$.appGroups'),
      parameters: {
        'appsGroup.$': '$$.Map.Item.Value',
        'cmd.$': '$.cmd',
        'version.$': '$.version',
      },
    })

    // apps in each group are deployed in parallel
    const appsMapTask = new Map(this, 'AppsMapTask', {
      // inputPath: JsonPath.stringAt('$.appsGroup'),
      itemsPath: JsonPath.stringAt('$.appsGroup'),
      parameters: {
        'app.$': '$$.Map.Item.Value.app',
        'regcode.$': '$$.Map.Item.Value.regcode',
        'cmd.$': '$.cmd',
        'version.$': '$.version',
      },
    })

    // start deployer in codebuild with env vars mapped from task input
    const runDeployerTask = new CodeBuildStartBuild(this, 'RunDeployerTask', {
      project: this.codeBuildRoPrj,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: this.deployerEnvVars(),
    })

    const definition = appsGroupsMapTask.iterator(
      appsMapTask.iterator(runDeployerTask)
    )

    this.appDeployerStateMachine = new StateMachine(
      this,
      'AppDeployerStateMachine',
      {
        stateMachineName: deterministicName(
          { name: 'AppDeployer', region: null, app: null },
          this
        ),
        definition,
      }
    )
  }

  private createCodeBuild(rw: boolean) {
    const logsDirectory = 'logs'
    const append = rw ? 'rw' : 'ro'
    const projectName = deterministicName(
      {
        region: null,
        append,
      },
      this
    )

    const projectClass = Project
    const codeBuild = new projectClass(this, `CodeBuild-${append}`, {
      projectName,
      logging: {
        cloudWatch: {
          logGroup: this.stateStack.deployerLogGroup,
        },
      },
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
        privileged: true,
        environmentVariables: {
          DEPLOYER_IMAGE: {
            value: this.stateStack.deployerEcrRepo.repositoryUri,
          },
        },
      },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        artifacts: {
          'base-directory': logsDirectory,
          files: ['**/*'],
        },
        phases: {
          pre_build: {
            commands: [
              'CREDS=$(curl -s 169.254.170.2$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)',
              'export AWS_SESSION_TOKEN=$(echo "${CREDS}" | jq -r \'.Token\')',
              'export AWS_ACCESS_KEY_ID=$(echo "${CREDS}" | jq -r \'.AccessKeyId\')',
              'export AWS_SECRET_ACCESS_KEY=$(echo "${CREDS}" | jq -r \'.SecretAccessKey\')',
              '$(aws ecr get-login --no-include-email)',
              'export IMAGE=${DEPLOYER_IMAGE}:${VERSION:-$(cat $APP)}',
              'docker pull $IMAGE',
              `mkdir ${logsDirectory}`,
            ],
          },
          build: {
            commands: [
              [
                'docker run --rm',
                '-e AWS_SESSION_TOKEN',
                '-e AWS_ACCESS_KEY_ID',
                '-e AWS_SECRET_ACCESS_KEY',
                '-e AWS_DEFAULT_REGION',
                '-e AWS_REGION',
                '$IMAGE',
                'app="$APP" stage="$STAGE" regcode="$REGCODE" $CMD',
                `|& tee ${logsDirectory}/$CMD-$APP-$STAGE-$REGCODE.txt`,
                '&& test ${PIPESTATUS[0]} -eq 0',
              ].join(' '),
            ],
          },
        },
      }),
    })

    codeBuild.addToRolePolicy(
      new PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    )

    const cdkRoleTypes = rw
      ? ['deploy', 'file-publishing', 'image-publishing', 'lookup']
      : ['lookup']

    codeBuild.addToRolePolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: cdkRoleTypes.map((type) =>
          Arn.format(
            {
              region: '',
              service: 'iam',
              resource: 'role',
              resourceName: `cdk-hnb659fds-${type}-role-${Aws.ACCOUNT_ID}-*`,
            },
            this
          )
        ),
      })
    )

    // grant role access to secret
    codeBuild.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: [
          Arn.format(
            {
              service: 'secretsmanager',
              resource: 'secret',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
              resourceName: `${this.config.project}/${this.config.stageName}/age-key-??????`,
            },
            this
          ),
        ],
      })
    )

    if (!codeBuild.role) {
      throw Error('No role found on codeBuild project instance')
    }

    this.stateStack.deployerEcrRepo.grantPull(codeBuild.role)

    if (rw) {
      // grant role access to create and update app secrets
      codeBuild.addToRolePolicy(
        new PolicyStatement({
          actions: [
            'secretsmanager:UpdateSecret',
            'secretsmanager:CreateSecret',
          ],
          resources: [
            Arn.format(
              {
                region: '*',
                service: 'secretsmanager',
                resource: 'secret',
                arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                resourceName: `${this.config.project}/${this.config.stageName}/*`,
              },
              this
            ),
          ],
        })
      )
    }

    return codeBuild
  }

  private initCodeBuildRoPrj() {
    this.codeBuildRoPrj = this.createCodeBuild(false)
  }

  private initCodeBuildRwPrj() {
    this.codeBuildRwPrj = this.createCodeBuild(true)
  }
}
