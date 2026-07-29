import type { DescMessage, DescMethod, DescService } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import type { GenService } from "@bufbuild/protobuf/codegenv2";
import type { MethodDescriptorProto } from "@bufbuild/protobuf/wkt";
import { MethodDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	AgentService,
	type GetAllowedModelIntentsRequestSchema,
	type GetAllowedModelIntentsResponseSchema,
	type GetDefaultModelForCliRequestSchema,
	type GetDefaultModelForCliResponseSchema,
	type GetUsableModelsRequestSchema,
	type GetUsableModelsResponseSchema,
	type NameAgentRequestSchema,
	type NameAgentResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import {
	BidiAppendRequestSchema,
	BidiAppendResponseSchema,
	BidiPollRequestSchema,
	BidiPollResponseSchema,
	BidiRequestIdSchema,
	BidiService,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/bidi_pb";
import {
	GetServerConfigRequestSchema,
	GetServerConfigResponseSchema,
	ServerConfigService,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";

/**
 * Corrected transport descriptors for Cursor's AgentService.
 *
 * The generated `AgentService` declares `Run` and `RunSSE` as `unary` because
 * the upstream proto file uses `rpc` without `stream`. The vendor wire contract
 * recovered from the installed CLI declares them as BiDiStreaming and
 * ServerStreaming respectively. `RunPoll` (also ServerStreaming) is present in
 * the vendor descriptor but absent from the worktree proto; it is synthesized
 * here from the BidiPoll message types.
 *
 * Every method is cloned so patching `parent` does not mutate the original
 * service's methods. The `parent` of every method is set to the returned
 * service descriptor so `method.parent.typeName` resolves to
 * `agent.v1.AgentService`.
 */

type MethodKind = DescMethod["methodKind"];

interface MethodCorrection {
	methodKind: MethodKind;
	input?: DescMessage;
	output?: DescMessage;
}

function makeMethodProto(
	name: string,
	input: DescMessage,
	output: DescMessage,
	methodKind: MethodKind,
): MethodDescriptorProto {
	const isClientStreaming = methodKind === "client_streaming" || methodKind === "bidi_streaming";
	const isServerStreaming = methodKind === "server_streaming" || methodKind === "bidi_streaming";
	return create(MethodDescriptorProtoSchema, {
		name,
		inputType: input.typeName,
		outputType: output.typeName,
		clientStreaming: isClientStreaming,
		serverStreaming: isServerStreaming,
	});
}

/**
 * Runtime correction of a service descriptor: clone every method, apply
 * methodKind/input/output overrides, synthesize missing methods, and patch
 * `parent` to the returned service.
 */
function buildCorrectedService(original: DescService, corrections: Record<string, MethodCorrection>): DescService {
	const correctedMethods: Record<string, DescMethod> = {};

	// Pass 1: clone every existing method (even unchanged ones) so patching
	// `parent` never mutates the original service's methods. Apply all
	// supplied overrides (methodKind, input, output, proto) to corrected
	// methods.
	for (const [key, method] of Object.entries(original.method)) {
		const correction = corrections[key];
		if (correction) {
			const input = correction.input ?? method.input;
			const output = correction.output ?? method.output;
			correctedMethods[key] = Object.assign(Object.create(method), {
				methodKind: correction.methodKind,
				input,
				output,
				proto: makeMethodProto(method.name, input, output, correction.methodKind),
			});
		} else {
			correctedMethods[key] = Object.create(method);
		}
	}

	// Track which corrections need synthesized methods (not in generated service).
	const toSynthesize: Array<{
		key: string;
		methodKind: MethodKind;
		input: DescMessage;
		output: DescMessage;
	}> = [];
	for (const [key, correction] of Object.entries(corrections)) {
		if (!correctedMethods[key] && correction.input && correction.output) {
			toSynthesize.push({
				key,
				methodKind: correction.methodKind,
				input: correction.input,
				output: correction.output,
			});
		}
	}

	// Create the corrected service shell so synthesized methods can reference
	// it as their parent.
	const serviceShell: DescService = {
		...original,
		method: correctedMethods,
		methods: [],
	};

	// Pass 1b: synthesize methods not in the generated service (e.g., RunPoll).
	for (const { key, methodKind, input, output } of toSynthesize) {
		const pascalName = key.charAt(0).toUpperCase() + key.slice(1);
		correctedMethods[key] = {
			kind: "rpc",
			name: pascalName,
			localName: key,
			methodKind,
			input,
			output,
			parent: serviceShell,
			idempotency: 0,
			deprecated: false,
			proto: makeMethodProto(pascalName, input, output, methodKind),
			toString() {
				return `${original.typeName}.${pascalName}`;
			},
		};
	}

	// Finalize the service with all methods.
	const correctedService: DescService = {
		...serviceShell,
		method: correctedMethods,
		methods: Object.values(correctedMethods),
	};

	// Pass 2: patch every method's `parent` to the final service.
	for (const method of Object.values(correctedMethods)) {
		Object.defineProperty(method, "parent", {
			value: correctedService,
			writable: false,
			enumerable: true,
			configurable: false,
		});
	}

	return correctedService;
}

/**
 * Corrected AgentService type: Run is BiDiStreaming, RunSSE and RunPoll are
 * ServerStreaming. All other methods retain their original kinds.
 */
export type CursorAgentServiceType = GenService<{
	run: {
		methodKind: "bidi_streaming";
		input: typeof AgentClientMessageSchema;
		output: typeof AgentServerMessageSchema;
	};
	runSSE: {
		methodKind: "server_streaming";
		input: typeof BidiRequestIdSchema;
		output: typeof AgentServerMessageSchema;
	};
	runPoll: {
		methodKind: "server_streaming";
		input: typeof BidiPollRequestSchema;
		output: typeof BidiPollResponseSchema;
	};
	nameAgent: { methodKind: "unary"; input: typeof NameAgentRequestSchema; output: typeof NameAgentResponseSchema };
	getUsableModels: {
		methodKind: "unary";
		input: typeof GetUsableModelsRequestSchema;
		output: typeof GetUsableModelsResponseSchema;
	};
	getDefaultModelForCli: {
		methodKind: "unary";
		input: typeof GetDefaultModelForCliRequestSchema;
		output: typeof GetDefaultModelForCliResponseSchema;
	};
	getAllowedModelIntents: {
		methodKind: "unary";
		input: typeof GetAllowedModelIntentsRequestSchema;
		output: typeof GetAllowedModelIntentsResponseSchema;
	};
}>;

/**
 * Corrected AgentService descriptor: Run is BiDiStreaming, RunSSE and RunPoll
 * are ServerStreaming. All other methods (NameAgent, GetUsableModels, etc.)
 * remain unchanged from the generated descriptor.
 *
 * Typed as `CursorAgentServiceType` so `createClient` produces the correct
 * method signatures.
 */
export const CursorAgentService: CursorAgentServiceType = buildCorrectedService(AgentService, {
	run: { methodKind: "bidi_streaming" },
	runSSE: { methodKind: "server_streaming", input: BidiRequestIdSchema, output: AgentServerMessageSchema },
	runPoll: { methodKind: "server_streaming", input: BidiPollRequestSchema, output: BidiPollResponseSchema },
}) as CursorAgentServiceType;

// Re-export unchanged services with their original GenService types.
// Re-export schemas for convenience.
export {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiAppendResponseSchema,
	BidiPollRequestSchema,
	BidiPollResponseSchema,
	BidiRequestIdSchema,
	BidiService as CursorBidiService,
	GetServerConfigRequestSchema,
	GetServerConfigResponseSchema,
	ServerConfigService as CursorServerConfigService,
};
