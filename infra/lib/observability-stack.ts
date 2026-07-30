import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import { RestApi } from "aws-cdk-lib/aws-apigateway";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Function } from "aws-cdk-lib/aws-lambda";
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { StageConfig } from "./config";

export interface ObservabilityStackProps extends StackProps {
  readonly config: StageConfig;
  readonly routesTable: Table;
  readonly proxyFunction: Function;
  readonly reconcilerFunction: Function;
  readonly api: RestApi;
}

export class ObservabilityStack extends Stack {
  public constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const alarms = new Topic(this, "AlarmTopic", {
      displayName: `Sinatra MicroVM alarms (${props.config.stage})`
    });
    const proxyErrors = new Alarm(this, "ProxyErrors", {
      metric: props.proxyFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });
    const reconcileErrors = new Alarm(this, "ReconcilerErrors", {
      metric: props.reconcilerFunction.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });
    const throttles = new Alarm(this, "RouteTableThrottles", {
      metric: props.routesTable.metric("ThrottledRequests", { period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });
    for (const alarm of [proxyErrors, reconcileErrors, throttles]) alarm.addAlarmAction(new SnsAction(alarms));

    const dashboard = new Dashboard(this, "Dashboard", {
      dashboardName: `sinatra-microvms-${props.config.stage}`
    });
    dashboard.addWidgets(
      new GraphWidget({
        title: "Control plane errors and duration",
        left: [props.proxyFunction.metricErrors(), props.reconcilerFunction.metricErrors()],
        right: [props.proxyFunction.metricDuration(), props.reconcilerFunction.metricDuration()]
      }),
      new GraphWidget({
        title: "Public API",
        left: [props.api.metricCount(), props.api.metricServerError()],
        right: [props.api.metricLatency()]
      })
    );

    new CfnOutput(this, "AlarmTopicArn", { value: alarms.topicArn });
  }
}
