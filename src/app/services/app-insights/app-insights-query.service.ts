import { Injectable } from "@angular/core";
import { FilterBuilder } from "@batch-flask/core";
import {
    AppInsightsMetricBody,
    AppInsightsMetricsResult,
    BatchPerformanceMetrics,
    PerformanceMetric,
} from "app/models/app-insights";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { AppInsightsApiService } from "./app-insights-api.service";
import { MetricDefinition } from "./metric-definition";
import { AppInsightQueryResultProcessor } from "./query-result-processor";

const metrics: StringMap<MetricDefinition> = {
    cpuUsage: { appInsightsMetricId: "customMetrics/Cpu usage", segment: "cloud/roleInstance" },
    individualCpuUsage: { appInsightsMetricId: "customMetrics/Cpu usage", segment: "customDimensions/[CPU #]" },
    gpuUsage: { appInsightsMetricId: "customMetrics/Gpu usage", segment: "cloud/roleInstance" },
    individualGpuUsage: { appInsightsMetricId: "customMetrics/Gpu usage", segment: "customDimensions/[GPU #]" },
    gpuMemory: { appInsightsMetricId: "customMetrics/Gpu memory usage", segment: "cloud/roleInstance" },
    individualGpuMemory: { appInsightsMetricId: "customMetrics/Gpu memory usage", segment: "customDimensions/[GPU #]" },
    memoryAvailable: { appInsightsMetricId: "customMetrics/Memory available", segment: "cloud/roleInstance" },
    memoryUsed: { appInsightsMetricId: "customMetrics/Memory used", segment: "cloud/roleInstance" },
    diskRead: { appInsightsMetricId: "customMetrics/Disk read", segment: "cloud/roleInstance" },
    diskWrite: { appInsightsMetricId: "customMetrics/Disk write", segment: "cloud/roleInstance" },
    diskUsed: { appInsightsMetricId: "customMetrics/Disk usage", segment: "customDimensions/Disk,cloud/roleInstance" },
    diskFree: { appInsightsMetricId: "customMetrics/Disk free", segment: "customDimensions/Disk,cloud/roleInstance" },
    networkRead: { appInsightsMetricId: "customMetrics/Network read", segment: "cloud/roleInstance" },
    networkWrite: { appInsightsMetricId: "customMetrics/Network write", segment: "cloud/roleInstance" },
};

@Injectable({ providedIn: "root" })
export class AppInsightsQueryService {
    constructor(private appInsightsApi: AppInsightsApiService) { }

    /**
     * Run the given query and return the result
     * @param query
     */
    public query(appId: string, query: string) {
        return this.appInsightsApi.get(`apps/${appId}/query`, {
            params: { query },
        });
    }

    /**
     * Run the given metrics query and return the result
     * @param query
     */
    public metrics(appId: string, query: any) {
        return this.appInsightsApi.post<any>(`apps/${appId}/metrics`, query);
    }

    public getPoolPerformance(appId: string, poolId: string, lastNMinutes: number):
        Observable<BatchPerformanceMetrics> {
        return this.metrics(appId, this._buildQuery(poolId, null, lastNMinutes)).pipe(map((data) => {
            return this._processMetrics(data);
        }));
    }

    public getNodePerformance(appId: string, poolId: string, nodeId: string, lastNMinutes: number):
        Observable<BatchPerformanceMetrics> {
        return this.metrics(appId, this._buildQuery(poolId, nodeId, lastNMinutes)).pipe(map((data) => {
            return this._processMetrics(data);
        }));
    }

    private _buildQuery(poolId: string, nodeId: string, timespanInMinutes: number) {
        const timespan = `PT${timespanInMinutes}M`;
        const interval = this._computeInterval(timespanInMinutes);
        return Object.keys(metrics).map((id) => {
            const metric = metrics[id];
            return {
                id: id,
                parameters: {
                    aggregation: "avg",
                    metricId: metric.appInsightsMetricId,
                    filter: this._buildFilter(poolId, nodeId).toOData(),
                    interval,
                    timespan,
                    segment: metric.segment,
                    top: 1000,
                },
            };
        });
    }

    private _computeInterval(timespan: number) {
        const numberOfPoints = 1000;
        const intervalInSeconds = Math.ceil(timespan / numberOfPoints * 60 / 10) * 10;
        return `PT${intervalInSeconds}S`;
    }

    private _buildFilter(poolId: string, nodeId?: string) {
        const poolFilter = FilterBuilder.prop("cloud/roleName").eq(poolId);
        if (nodeId) {
            const nodeFilter = FilterBuilder.prop("cloud/roleInstance").eq(nodeId);
            return FilterBuilder.and(poolFilter, nodeFilter);
        } else {
            return poolFilter;
        }
    }

    private _processMetrics(data: AppInsightsMetricsResult): BatchPerformanceMetrics {
        const performances = {};
        for (const metricResult of data) {
            const id = metricResult.id;
            const data = metricResult.body.value;
            const segments = metricResult.body.value.segments;
            switch (id) {
                case "individualCpuUsage":
                    performances[id] = this._processIndividualDeviceUsage(id, "customDimensions/CPU #", segments);
                    break;
                case "individualGpuUsage":
                case "individualGpuMemory":
                    performances[id] = this._processIndividualDeviceUsage(id, "customDimensions/GPU #", segments);
                    break;
                default:
                    performances[id] = this._processSegmentedMetric(id, data);
            }
        }
        return performances as BatchPerformanceMetrics;
    }

    private _processIndividualDeviceUsage(id: string, deviceKey: string, segments): StringMap<PerformanceMetric[]> {
        const usages: StringMap<PerformanceMetric[]> = {};
        for (const segment of segments) {
            const time = this._getDateAvg(new Date(segment.start), new Date(segment.end));

            for (const individualSegment of segment.segments) {
                const value = individualSegment[this._getAppInsightsMetricId(id)].avg;
                const deviceId = individualSegment[deviceKey];
                if (!(deviceId in usages)) {
                    usages[deviceId] = [];
                }
                usages[deviceId].push({
                    time,
                    value,
                });
            }
        }
        return usages;
    }

    private _processSegmentedMetric<T>(metricId: string, segments: AppInsightsMetricBody): T {
        const metric = metrics[metricId];
        const processor = new AppInsightQueryResultProcessor(metric);
        return processor.process(segments);
    }

    private _getDateAvg(start: Date, end: Date): Date {
        return new Date((end.getTime() + start.getTime()) / 2);
    }

    private _getAppInsightsMetricId(id: string) {
        return metrics[id].appInsightsMetricId;
    }
}
