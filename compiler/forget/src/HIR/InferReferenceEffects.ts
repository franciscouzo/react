/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assertExhaustive } from "../Common/utils";
import { invariant } from "../CompilerError";
import {
  BasicBlock,
  BlockId,
  Effect,
  HIRFunction,
  IdentifierId,
  Instruction,
  InstructionValue,
  Place,
  Terminal,
  ValueKind,
} from "./HIR";
import { mapTerminalSuccessors } from "./HIRBuilder";
import { printMixedHIR } from "./PrintHIR";

/**
 * For every usage of a value in the given function, infers the effect or action
 * taken at that reference. Each reference is inferred as exactly one of:
 * - freeze: this usage freezes the value, ie converts it to frozen. This is only inferred
 *   when the value *may* not already be frozen.
 * - frozen: the value is known to already be "owned" by React and is therefore already
 *   frozen (permanently and transitively immutable).
 * - immutable: the value is not owned by React, but is known to be an immutable value
 *   that therefore cannot ever change.
 * - readonly: the value is not frozen or immutable, but this usage of the value does
 *   not modify it. the value may be mutated by a subsequent reference. Examples include
 *   referencing the operands of a binary expression, or referencing the items/properties
 *   of an array or object literal.
 * - mutable: the value is not frozen or immutable, and this usage *may* modify it.
 *   Examples include passing a value to as a function argument or assigning into an object.
 *
 * Note that the inference follows variable assignment, so assigning a frozen value
 * to a different value will infer usages of the other variable as frozen as well.
 *
 * The inference assumes that the code follows the rules of React:
 * - React function arguments are frozen (component props, hook arguments).
 * - Hook arguments are frozen at the point the hook is invoked.
 * - React function return values are frozen at the point of being returned,
 *   thus the return value of a hook call is frozen.
 * - JSX represents invocation of a React function (the component) and
 *   therefore all values passed to JSX become frozen at the point the JSX
 *   is created.
 *
 * Internally, the inference tracks the approximate type of value held by each variable,
 * and iterates over the control flow graph. The inferred effect of reach reference is
 * a combination of the operation performed (ie, assignment into an object mutably uses the
 * object; an if condition reads the condition) and the type of the value. The types of values
 * are:
 * - frozen: can be any type so long as the value is known to be owned by React, permanently
 *   and transitively immutable
 * - maybe-frozen: the value may or may not be frozen, conditionally depending on control flow.
 * - immutable: a type with value semantics: primitives, records/tuples when standardized.
 * - mutable: a type with reference semantics eg array, object, class instance, etc.
 *
 * When control flow paths converge the types of values are merged together, with the value
 * types forming a lattice to ensure convergence.
 */
export default function inferReferenceEffects(fn: HIRFunction) {
  // Initial environment contains function params
  // TODO: include module declarations here as well
  const initialEnvironment = Environment.empty();
  const id: Place = {
    kind: "Identifier",
    memberPath: null,
    identifier: fn.id as any,
    path: null as any, // TODO
    effect: Effect.Freeze,
  };
  const value: InstructionValue = {
    kind: "Primitive",
    path: null as any, // TODO
    value: undefined,
  };
  initialEnvironment.initialize(value, ValueKind.Frozen);
  initialEnvironment.define(id, value);

  for (const param of fn.params) {
    const value: InstructionValue = {
      kind: "Primitive",
      path: null as any, // TODO
      value: undefined,
    };
    initialEnvironment.initialize(value, ValueKind.Frozen);
    initialEnvironment.define(param, value);
  }

  // Map of blocks to the last (merged) incoming environment that was processed
  const environmentsByBlock: Map<BlockId, Environment> = new Map();

  // Multiple predecessors may be visited prior to reaching a given successor,
  // so track the list of incoming environments for each successor block.
  // These are merged when reaching that block again.
  const queuedEnvironments: Map<BlockId, Environment> = new Map();
  function queue(blockId: BlockId, environment: Environment) {
    let queuedEnvironment = queuedEnvironments.get(blockId);
    if (queuedEnvironment != null) {
      // merge the queued environments for this block
      environment = queuedEnvironment.merge(environment) ?? environment;
      queuedEnvironments.set(blockId, environment);
    } else {
      // this is the first queued environment for this block, see whether
      // there are changed relative to the last time it was processed.
      const prevEnvironment = environmentsByBlock.get(blockId);
      const nextEnvironment =
        prevEnvironment != null
          ? prevEnvironment.merge(environment)
          : environment;
      if (nextEnvironment != null) {
        queuedEnvironments.set(blockId, nextEnvironment);
      }
    }
  }
  queue(fn.body.entry, initialEnvironment);

  while (queuedEnvironments.size !== 0) {
    for (const [blockId, block] of fn.body.blocks) {
      const incomingEnvironment = queuedEnvironments.get(blockId);
      queuedEnvironments.delete(blockId);
      if (incomingEnvironment == null) {
        continue;
      }

      environmentsByBlock.set(blockId, incomingEnvironment);
      const environment = incomingEnvironment.clone();
      inferBlock(environment, block);

      // TODO: add a `forEachTerminalSuccessor` helper, we don't actually want the result
      // here
      const _ = mapTerminalSuccessors(
        block.terminal,
        (nextBlockId, isFallthrough) => {
          if (!isFallthrough) {
            queue(nextBlockId, environment);
          }
          return nextBlockId;
        }
      );
    }
  }
}

/**
 * Maintains a mapping of top-level variables to the kind of value they hold
 */
class Environment {
  // The kind of reach value, based on its allocation site
  #values: Map<InstructionValue, ValueKind>;
  // The set of values pointed to by each identifier. This is a set
  // to accomodate phi points (where a variable may have different
  // values from different control flow paths).
  #variables: Map<IdentifierId, Set<InstructionValue>>;

  constructor(
    values: Map<InstructionValue, ValueKind>,
    variables: Map<IdentifierId, Set<InstructionValue>>
  ) {
    this.#values = values;
    this.#variables = variables;
  }

  static empty(): Environment {
    return new Environment(new Map(), new Map());
  }

  /**
   * (Re)initializes a @param value with its default @param kind.
   */
  initialize(
    value: InstructionValue,
    kind: ValueKind,
    instr: Instruction | null = null
  ) {
    invariant(
      value.kind !== "Identifier" || value.memberPath !== null,
      "Expected all top-level identifiers to be defined as variables, not values"
    );
    this.#values.set(value, kind);
  }

  /**
   * Lookup the kind of the given @param value.
   */
  kind(place: Place): ValueKind {
    const values = this.#variables.get(place.identifier.id);
    invariant(
      values != null,
      `Expected value kind to be initialized at '${String(place.path)}'`
    );
    let mergedKind: ValueKind | null = null;
    for (const value of values) {
      const kind = this.#values.get(value)!;
      mergedKind = mergedKind !== null ? mergeValues(mergedKind, kind) : kind;
    }
    invariant(mergedKind !== null, "Expected at least value");
    return mergedKind;
  }

  /**
   * Updates the value at @param place to point to the same value as @param value.
   */
  alias(place: Place, value: Place) {
    const values = this.#variables.get(value.identifier.id);
    invariant(
      values != null,
      `Expected value to be populated at '${String(value.path)}' in '${String(
        value.path.parentPath
      )}'`
    );
    this.#variables.set(place.identifier.id, new Set(values));
  }

  /**
   * Defines (initializing or updating) a variable with a specific kind of value.
   */
  define(place: Place, value: InstructionValue) {
    invariant(
      place.memberPath === null,
      "Expected a top-level identifier, not a member path"
    );
    invariant(
      this.#values.has(value),
      `Expected value to be initialized at '${String(value.path)}' in '${String(
        value.path?.parentPath
      )}'`
    );
    this.#variables.set(place.identifier.id, new Set([value]));
  }

  /**
   * Records that a given Place was accessed with the given kind and:
   * - Updates the effect of @param place based on the kind of value
   *   and the kind of reference (@param effectKind).
   * - Updates the value kind to reflect the effect of the reference.
   *
   * Notably, a mutable reference is downgraded to readonly if the
   * value unless the value is known to be mutable.
   *
   * Similarly, a freeze reference is converted to readonly if the
   * value is already frozen or is immutable.
   */
  reference(place: Place, effectKind: Effect) {
    const values = this.#variables.get(place.identifier.id);
    if (values === undefined) {
      place.effect = effectKind === Effect.Mutate ? Effect.Mutate : Effect.Read;
      return;
    }
    let valueKind: ValueKind | null = this.kind(place);
    let effect: Effect | null = null;
    switch (effectKind) {
      case Effect.Freeze: {
        if (
          valueKind === ValueKind.Mutable ||
          valueKind === ValueKind.MaybeFrozen
        ) {
          effect = Effect.Freeze;
          valueKind = ValueKind.Frozen;
          values.forEach((value) => this.#values.set(value, ValueKind.Frozen));
        } else {
          effect = Effect.Read;
        }
        break;
      }
      case Effect.Mutate: {
        if (valueKind === ValueKind.Mutable) {
          effect = Effect.Mutate;
        } else {
          effect = Effect.Read;
        }
        break;
      }
      case Effect.Read: {
        effect = Effect.Read;
        break;
      }
      case Effect.Unknown: {
        invariant(
          false,
          "Unexpected unknown effect, expected to infer a precise effect kind"
        );
      }
      default: {
        assertExhaustive(
          effectKind,
          `Unexpected reference kind '${effectKind as any as string}'`
        );
      }
    }
    invariant(effect !== null, "Expected effect to be set");
    place.effect = effect;
  }

  /**
   * Combine the contents of @param this and @param other, returning a new
   * instance with the combined changes _if_ there are any changes, or
   * returning null if no changes would occur. Changes include:
   * - new entries in @param other that did not exist in @param this
   * - entries whose values differ in @param this and @param other,
   *   and where joining the values produces a different value than
   *   what was in @param this.
   *
   * Note that values are joined using a lattice operation to ensure
   * termination.
   */
  merge(other: Environment): Environment | null {
    let nextValues: Map<InstructionValue, ValueKind> | null = null;
    let nextVariables: Map<IdentifierId, Set<InstructionValue>> | null = null;

    for (const [id, thisValue] of this.#values) {
      const otherValue = other.#values.get(id);
      if (otherValue !== undefined) {
        const mergedValue = mergeValues(thisValue, otherValue);
        if (mergedValue !== thisValue) {
          nextValues = nextValues ?? new Map(this.#values);
          nextValues.set(id, mergedValue);
        }
      }
    }
    for (const [id, otherValue] of other.#values) {
      if (this.#values.has(id)) {
        // merged above
        continue;
      }
      nextValues = nextValues ?? new Map(this.#values);
      nextValues.set(id, otherValue);
    }

    for (const [id, thisValues] of this.#variables) {
      const otherValues = other.#variables.get(id);
      if (otherValues !== undefined) {
        let mergedValues: Set<InstructionValue> | null = null;
        for (const otherValue of otherValues) {
          if (!thisValues.has(otherValue)) {
            mergedValues = mergedValues ?? new Set(thisValues);
            mergedValues.add(otherValue);
          }
        }
        if (mergedValues !== null) {
          nextVariables = nextVariables ?? new Map(this.#variables);
          nextVariables.set(id, mergedValues);
        }
      }
    }
    for (const [id, otherValues] of other.#variables) {
      if (this.#variables.has(id)) {
        continue;
      }
      nextVariables = nextVariables ?? new Map(this.#variables);
      nextVariables.set(id, new Set(otherValues));
    }

    if (nextVariables === null && nextValues === null) {
      return null;
    } else {
      return new Environment(
        nextValues ?? new Map(this.#values),
        nextVariables ?? new Map(this.#variables)
      );
    }
  }

  /**
   * Returns a copy of this environment.
   * TODO: consider using persistent data structures to make
   * clone cheaper.
   */
  clone(): Environment {
    return new Environment(new Map(this.#values), new Map(this.#variables));
  }

  /**
   * For debugging purposes, dumps the environment to a plain
   * object so that it can printed as JSON.
   */
  debug(): any {
    const result: any = { values: {}, variables: {} };
    const objects: Map<InstructionValue, number> = new Map();
    function identify(value: InstructionValue): number {
      let id = objects.get(value);
      if (id == null) {
        id = objects.size;
        objects.set(value, id);
      }
      return id;
    }
    for (const [value, kind] of this.#values) {
      const id = identify(value);
      result.values[id] = { kind, value: printMixedHIR(value) };
    }
    for (const [variable, values] of this.#variables) {
      result.variables[variable] = [...values].map(identify);
    }
    return result;
  }
}

/**
 * Joins two values using the following rules:
 * == Effect Transitions ==
 *
 * Freezing an immutable value has not effect:
 *               ┌───────────────┐
 *               │               │
 *               ▼               │ Freeze
 * ┌──────────────────────────┐  │
 * │        Immutable         │──┘
 * └──────────────────────────┘
 *
 * Freezing a mutable or maybe-frozen value makes it frozen. Freezing a frozen
 * value has no effect:
 *                                                    ┌───────────────┐
 * ┌─────────────────────────┐     Freeze             │               │
 * │       MaybeFrozen       │────┐                   ▼               │ Freeze
 * └─────────────────────────┘    │     ┌──────────────────────────┐  │
 *                                ├────▶│          Frozen          │──┘
 *                                │     └──────────────────────────┘
 * ┌─────────────────────────┐    │
 * │         Mutable         │────┘
 * └─────────────────────────┘
 *
 * == Join Lattice ==
 * - immutable | mutable => mutable
 *    The justification is that immutable and mutable values are different types,
 *    and functions can introspect them to tell the difference (if the argument
 *    is null return early, else if its an object mutate it).
 * - frozen | mutable => maybe-frozen
 *    Frozen values are indistinguishable from mutable values at runtime, so callers
 *    cannot dynamically avoid mutation of "frozen" values. If a value could be
 *    frozen we have to distinguish it from a mutable value. But it also isn't known
 *    frozen yet, so we distinguish as maybe-frozen.
 * - immutable | frozen => frozen
 *    This is subtle and falls out of the above rules. If a value could be any of
 *    immutable, mutable, or frozen, then at runtime it could either be a primitive
 *    or a reference type, and callers can't distinguish frozen or not for reference
 *    types. To ensure that any sequence of joins btw those three states yields the
 *    correct maybe-frozen, these two have to produce a frozen value.
 * - <any> | maybe-frozen => maybe-frozen
 *
 * ┌──────────────────────────┐
 * │        Immutable         │───┐
 * └──────────────────────────┘   │
 *                                │    ┌─────────────────────────┐
 *                                ├───▶│         Frozen          │──┐
 * ┌──────────────────────────┐   │    └─────────────────────────┘  │
 * │          Frozen          │───┤                                 │  ┌─────────────────────────┐
 * └──────────────────────────┘   │                                 ├─▶│       MaybeFrozen       │
 *                                │    ┌─────────────────────────┐  │  └─────────────────────────┘
 *                                ├───▶│       MaybeFrozen       │──┘
 * ┌──────────────────────────┐   │    └─────────────────────────┘
 * │         Mutable          │───┘
 * └──────────────────────────┘
 */
function mergeValues(a: ValueKind, b: ValueKind): ValueKind {
  if (a === b) {
    return a;
  } else if (a === ValueKind.MaybeFrozen || b === ValueKind.MaybeFrozen) {
    return ValueKind.MaybeFrozen;
    // after this a and b differ and neither are MaybeFrozen
  } else if (a === ValueKind.Mutable || b === ValueKind.Mutable) {
    if (a === ValueKind.Frozen || b === ValueKind.Frozen) {
      // frozen | mutable
      return ValueKind.MaybeFrozen;
    } else {
      // mutable | immutable
      return ValueKind.Mutable;
    }
  } else {
    // frozen | immutable
    return ValueKind.Frozen;
  }
}

/**
 * Iterates over the given @param block, defining variables and
 * recording references on the @param env according to JS semantics.
 */
function inferBlock(env: Environment, block: BasicBlock) {
  for (const instr of block.instructions) {
    const instrValue = instr.value;
    let valueKind: ValueKind;
    switch (instrValue.kind) {
      case "BinaryExpression": {
        valueKind = ValueKind.Immutable;
        env.reference(instrValue.left, Effect.Read);
        env.reference(instrValue.right, Effect.Read);
        break;
      }
      case "ArrayExpression": {
        valueKind = ValueKind.Mutable;
        for (const element of instrValue.elements) {
          env.reference(element, Effect.Read);
        }
        break;
      }
      case "NewExpression": {
        valueKind = ValueKind.Mutable;
        env.reference(instrValue.callee, Effect.Mutate);
        for (const arg of instrValue.args) {
          env.reference(arg, Effect.Mutate);
        }
        break;
      }
      case "CallExpression": {
        let effectKind = Effect.Mutate;
        valueKind = ValueKind.Mutable;
        const hook = parseHookCall(instrValue.callee);
        if (hook !== null) {
          effectKind = hook.effectKind;
          valueKind = hook.valueKind;
        }
        env.reference(instrValue.callee, effectKind);
        for (const arg of instrValue.args) {
          env.reference(arg, effectKind);
        }
        break;
      }
      case "ObjectExpression": {
        valueKind = ValueKind.Mutable;
        // Object construction captures but does not modify the key/property values
        if (instrValue.properties !== null) {
          for (const [_key, value] of instrValue.properties) {
            env.reference(value, Effect.Read);
          }
        }
        break;
      }
      case "UnaryExpression": {
        // TODO check that value must be a primitive, or make conditional based on the operator
        valueKind = ValueKind.Immutable;
        env.reference(instrValue.value, Effect.Read);
        break;
      }
      case "OtherStatement": {
        // TODO: handle other statement kinds
        valueKind = ValueKind.Mutable;
        break;
      }
      case "JsxExpression": {
        valueKind = ValueKind.Frozen;
        env.reference(instrValue.tag, Effect.Freeze);
        for (const [_prop, value] of instrValue.props) {
          env.reference(value, Effect.Freeze);
        }
        if (instrValue.children !== null) {
          for (const child of instrValue.children) {
            env.reference(child, Effect.Freeze);
          }
        }
        break;
      }
      case "JSXText":
      case "Primitive": {
        valueKind = ValueKind.Immutable;
        break;
      }
      case "Identifier": {
        env.reference(instrValue, Effect.Read);
        const lvalue = instr.lvalue;
        if (lvalue !== null) {
          lvalue.place.effect = Effect.Mutate;
          if (
            lvalue.place.memberPath === null &&
            instrValue.memberPath === null
          ) {
            // direct aliasing: `a = b`;
            env.alias(lvalue.place, instrValue);
          } else if (lvalue.place.memberPath === null) {
            // redefine lvalue: `a = b.c.d`
            env.initialize(instrValue, env.kind(instrValue));
            env.define(lvalue.place, instrValue);
          } else if (instrValue.memberPath === null) {
            // no-op: `a.b.c = d`
            env.reference(lvalue.place, Effect.Mutate);
          } else {
            // no-op: `a.b.c = d.e.f`
            env.reference(lvalue.place, Effect.Mutate);
          }
        }
        continue;
      }
      default: {
        assertExhaustive(instrValue, "Unexpected instruction kind");
      }
    }
    env.initialize(instrValue, valueKind, instr);
    if (instr.lvalue !== null) {
      if (instr.lvalue.place.memberPath === null) {
        env.define(instr.lvalue.place, instrValue);
      } else {
        env.reference(instr.lvalue.place, Effect.Mutate);
      }
      instr.lvalue.place.effect = Effect.Mutate;
    }
  }
  switch (block.terminal.kind) {
    case "throw": {
      env.reference(block.terminal.value, Effect.Freeze);
      break;
    }
    case "return": {
      if (block.terminal.value !== null) {
        env.reference(block.terminal.value, Effect.Freeze);
      }
      break;
    }
    case "if": {
      env.reference(block.terminal.test, Effect.Read);
      break;
    }
    case "switch": {
      for (const case_ of block.terminal.cases) {
        if (case_.test !== null) {
          env.reference(case_.test, Effect.Read);
        }
      }
      break;
    }
    case "goto": {
      break;
    }
    default: {
      assertExhaustive(
        block.terminal,
        `Unexpected terminal kind '${(block.terminal as any as Terminal).kind}'`
      );
    }
  }
}

const HOOKS: Map<string, Hook> = new Map([
  [
    "useState",
    {
      kind: "State",
      effectKind: Effect.Freeze,
      valueKind: ValueKind.Frozen,
    },
  ],
  [
    "useRef",
    {
      kind: "Ref",
      effectKind: Effect.Read,
      valueKind: ValueKind.Mutable,
    },
  ],
]);

type HookKind = { kind: "State" } | { kind: "Ref" } | { kind: "Custom" };
type Hook = HookKind & { effectKind: Effect; valueKind: ValueKind };

function parseHookCall(place: Place): Hook | null {
  if (place.memberPath !== null) {
    // Hook calls must be statically resolved
    return null;
  }
  const name = place.identifier.name;
  if (name === null || !name.match(/^_?use/)) {
    return null;
  }
  const hook = HOOKS.get(name);
  if (hook != null) {
    return hook;
  }
  return {
    kind: "Custom",
    effectKind: Effect.Freeze,
    valueKind: ValueKind.Frozen,
  };
}
