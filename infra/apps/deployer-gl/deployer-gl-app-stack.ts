import { Construct } from 'constructs'
import { deterministicName, setNameTag } from '../../lib/utils'
import { StackBase, StackBaseProps } from '../../lib/stack-base'
import { StateStack } from './state-stack'
import { DeployerGlStack } from './deployer-gl-stack'
import { CfnOutput } from 'aws-cdk-lib'
import { DeployerGlStageProps } from './deployer-gl-config'

export interface DeployerGlAppStackProps extends StackBaseProps {}

export class DeployerGlAppStack extends StackBase {
  protected readonly config: DeployerGlStageProps
  stateStack: StateStack
  deployerStack: DeployerGlStack

  constructor(scope: Construct, id: string, props: DeployerGlAppStackProps) {
    super(scope, id, props)
    this.initNestedStacks(props)
    this.initOutputs()
  }

  private initNestedStacks(props: DeployerGlAppStackProps) {
    this.stateStack = new StateStack(this, 'State', {
      config: props.config,
    })

    setNameTag(this.stateStack, 'StateStack')

    this.deployerStack = new DeployerGlStack(this, 'Deployer', {
      config: props.config,
      stateStack: this.stateStack,
    })

    setNameTag(this.deployerStack, 'DeployerGlStack')
  }

  private initOutputs() {
    new CfnOutput(this, 'CiRoleName', {
      value: this.stateStack.ciRole.roleName,
      exportName: deterministicName(this, 'CiRoleName'),
    })

    new CfnOutput(this, 'DeployerEcrRepoUri', {
      value: this.stateStack.deployerEcrRepo.repositoryUri,
      exportName: deterministicName(this, 'DeployerEcrRepoUri'),
    })

    new CfnOutput(this, 'ArtifactsBucketName', {
      value: this.stateStack.artifactsBucket.bucketName,
      exportName: deterministicName(this, 'ArtifactsBucketName'),
    })
  }
}