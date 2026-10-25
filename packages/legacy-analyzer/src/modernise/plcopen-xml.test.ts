import { describe, expect, it } from "vitest";
import { analysePlc } from "./plc-st.js";
import { parsePlcOpenXml, parseXml } from "./plcopen-xml.js";

// Fictional plant: the bottling line exported from an engineering tool as PLCopen XML.
const EXPORT = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <fileHeader companyName="Fictional Bottling" productName="Tool" productVersion="1" creationDateTime="2026-10-24T09:00:00"/>
  <types>
    <dataTypes>
      <dataType name="RecipeT">
        <baseType>
          <struct>
            <variable name="FillMl"><type><INT/></type></variable>
          </struct>
        </baseType>
      </dataType>
      <dataType name="FillState">
        <baseType><enum><values><value name="IDLE"/><value name="FILLING"/></values></enum></baseType>
      </dataType>
    </dataTypes>
    <pous>
      <pou name="Conveyor" pouType="functionBlock">
        <interface>
          <inputVars>
            <variable name="Start"><type><BOOL/></type></variable>
          </inputVars>
          <outputVars>
            <variable name="Drive"><type><BOOL/></type></variable>
          </outputVars>
          <localVars retain="true">
            <variable name="Delay"><type><derived name="TON"/></type></variable>
            <variable name="Speeds"><type><array><dimension lower="1" upper="4"/><baseType><INT/></baseType></array></type></variable>
          </localVars>
        </interface>
        <body>
          <ST>
            <xhtml:p><![CDATA[Delay(IN := Start, PT := T#2s);
IF Delay.Q THEN
  Drive := TRUE; (* a < b & c *)
END_IF;]]></xhtml:p>
          </ST>
        </body>
        <documentation><xhtml:p>Conveyor drive with start delay</xhtml:p></documentation>
      </pou>
      <pou name="Main" pouType="program">
        <interface>
          <localVars>
            <variable name="StartPb" address="%IX0.1"><type><BOOL/></type></variable>
            <variable name="Motor" address="%QX0.1"><type><BOOL/></type><initialValue><simpleValue value="FALSE"/></initialValue></variable>
            <variable name="Belt"><type><derived name="Conveyor"/></type></variable>
          </localVars>
        </interface>
        <body>
          <ST><xhtml:p>Belt(Start := StartPb AND NOT EStop);
Motor := Belt.Drive AND (Count &lt; 10);</xhtml:p></ST>
        </body>
      </pou>
      <pou name="Scale" pouType="function">
        <interface>
          <returnType><REAL/></returnType>
          <inputVars><variable name="Raw"><type><INT/></type></variable></inputVars>
        </interface>
        <body><ST><xhtml:p>Scale := INT_TO_REAL(Raw) / 10.0;</xhtml:p></ST></body>
      </pou>
      <pou name="Sequence" pouType="program">
        <body>
          <SFC><step name="Init" localId="1" initialStep="true"/></SFC>
        </body>
      </pou>
    </pous>
  </types>
  <instances>
    <configurations>
      <configuration name="Plant">
        <resource name="Cpu">
          <globalVars>
            <variable name="EStop" address="%IX0.0"><type><BOOL/></type></variable>
            <variable name="Spare" address="%IX0.1"><type><BOOL/></type></variable>
          </globalVars>
        </resource>
      </configuration>
    </configurations>
  </instances>
</project>
`;

const lineOf = (needle: string) => EXPORT.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("PLCopen XML reader", () => {
  const file = parsePlcOpenXml("plc/export/Line1.xml", EXPORT)!;

  it("reads POUs, variables and types at the XML line they came from", () => {
    expect(file.pous.map((p) => `${p.kind} ${p.name}:${p.line}-${p.endLine}`)).toEqual([
      `FUNCTION_BLOCK CONVEYOR:${lineOf('pou name="Conveyor"')}-${lineOf("<documentation>") + 1}`,
      `PROGRAM MAIN:${lineOf('pou name="Main"')}-${lineOf('pou name="Scale"') - 1}`,
      `FUNCTION SCALE:${lineOf('pou name="Scale"')}-${lineOf('pou name="Sequence"') - 1}`,
      `PROGRAM SEQUENCE:${lineOf('pou name="Sequence"')}-${lineOf("</pous>") - 1}`,
    ]);
    const conveyor = file.pous[0];
    expect(conveyor.doc).toBe("Conveyor drive with start delay");
    expect(conveyor.vars).toEqual([
      expect.objectContaining({
        name: "START",
        section: "VAR_INPUT",
        type: "BOOL",
        line: lineOf('"Start"'),
      }),
      expect.objectContaining({ name: "DRIVE", section: "VAR_OUTPUT", line: lineOf('"Drive"') }),
      expect.objectContaining({
        name: "DELAY",
        section: "VAR",
        qualifiers: ["RETAIN"],
        type: "TON",
      }),
      expect.objectContaining({ name: "SPEEDS", type: "ARRAY [1..4] OF INT" }),
    ]);
    expect(file.pous[2]).toMatchObject({ returns: "REAL" });
    expect(file.pous[1].vars[1]).toMatchObject({
      address: "%QX0.1",
      area: "output",
      init: "FALSE",
    });
    expect(file.types.map((t) => `${t.name}:${t.kind}:${t.line}`)).toEqual([
      `RecipeT:struct:${lineOf('"RecipeT"')}`,
      `FillState:enum:${lineOf('"FillState"')}`,
    ]);
    expect(file.globals.map((g) => `${g.name}@${g.address}:${g.line}`)).toEqual([
      `ESTOP@%IX0.0:${lineOf('"EStop"')}`,
      `SPARE@%IX0.1:${lineOf('"Spare"')}`,
    ]);
  });

  it("reads Structured Text bodies with the Structured Text rules, entities decoded", () => {
    const [conveyor, main] = file.pous;
    expect(conveyor.calls).toEqual([
      expect.objectContaining({
        name: "DELAY",
        kind: "instance",
        type: "TON",
        line: lineOf("Delay(IN"),
      }),
    ]);
    expect(conveyor.writes).toEqual([
      expect.objectContaining({ target: "DRIVE", line: lineOf("Drive := TRUE") }),
    ]);
    expect(main.writes.map((w) => `${w.target}:${w.line}`)).toEqual([
      `MOTOR:${lineOf("Motor := Belt.Drive")}`,
    ]);
    const a = analysePlc([file]);
    expect(a.instances.map((i) => `${i.pou} ${i.instance}:${i.type}`)).toEqual([
      "MAIN BELT:Conveyor",
    ]);
    expect(a.sharedAddresses.map((s) => s.address)).toEqual(["%IX0.1"]);
  });

  it("reports bodies in other languages as gaps, never guessed", () => {
    expect(file.gaps).toEqual([
      expect.objectContaining({ construct: "SFC", line: lineOf("<SFC>") }),
    ]);
    expect(file.pous[3].calls).toEqual([]);
  });

  it("reads FBD and LD networks: block calls, output and coil writes", () => {
    const NET = `<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types><pous>
    <pou name="Capper" pouType="program">
      <interface><localVars>
        <variable name="Torque"><type><derived name="TON"/></type></variable>
        <variable name="Clamp" address="%QX1.0"><type><BOOL/></type></variable>
      </localVars></interface>
      <body><FBD>
        <inVariable localId="1"><expression>CapSensor</expression></inVariable>
        <block localId="2" typeName="TON" instanceName="Torque"><inputVariables/></block>
        <block localId="3" typeName="LIMIT"><inputVariables/></block>
        <block localId="4" typeName="AND"><inputVariables/></block>
        <outVariable localId="5"><expression>Clamp</expression></outVariable>
        <outVariable localId="6"><expression>Arr[2]</expression></outVariable>
        <jump localId="7" label="Done"/>
      </FBD></body>
    </pou>
    <pou name="Rinser" pouType="program">
      <body><LD>
        <leftPowerRail localId="1"/>
        <contact localId="2"><variable>RinseReq</variable></contact>
        <block localId="3" typeName="TOF" instanceName="Drip"/>
        <coil localId="4" storage="set"><variable>Line.Rinse</variable></coil>
        <rightPowerRail localId="5"/>
      </LD></body>
    </pou>
  </pous></types>
</project>`;
    const at = (needle: string) => NET.split("\n").findIndex((l) => l.includes(needle)) + 1;
    const net = parsePlcOpenXml("plc/export/Capper.xml", NET)!;
    const [capper, rinser] = net.pous;
    expect(capper.calls.map((c) => `${c.name}:${c.kind}:${c.type ?? ""}:${c.line}`)).toEqual([
      `TORQUE:instance:TON:${at('instanceName="Torque"')}`,
      `LIMIT:function::${at('typeName="LIMIT"')}`,
    ]);
    expect(capper.writes.map((w) => `${w.target}:${w.line}`)).toEqual([
      `CLAMP:${at("<expression>Clamp")}`,
    ]);
    expect(rinser.calls).toEqual([
      expect.objectContaining({ name: "DRIP", kind: "function", line: at('"Drip"') }),
    ]);
    expect(rinser.writes.map((w) => `${w.target}:${w.line}`)).toEqual([
      `LINE.RINSE:${at("Line.Rinse")}`,
    ]);
    expect(net.gaps.map((g) => `${g.construct}:${g.line}`)).toEqual([
      `outVariable:${at("Arr[2]")}`,
      `jump:${at("<jump")}`,
    ]);
  });

  it("leaves non-PLCopen XML to the caller and reports malformed XML as a gap", () => {
    expect(parsePlcOpenXml("a.xml", "<RSLogix5000Content/>")).toBeUndefined();
    const bad = parsePlcOpenXml(
      "b.xml",
      '<project xmlns="http://www.plcopen.org/xml/tc6_0201">\n<types>\n</project>',
    )!;
    expect(bad.pous).toEqual([]);
    expect(bad.gaps).toEqual([
      expect.objectContaining({
        construct: "xml",
        line: 3,
        detail: expect.stringContaining("Unexpected </project>"),
      }),
    ]);
  });

  it("never applies DOCTYPE entity declarations", () => {
    const tree = parseXml(
      '<!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<p a="&x;&lt;">&x;&#65;</p>',
    );
    expect(tree.children[0].attrs.a).toBe("&x;<");
    expect(tree.children[0].text[0].value).toBe("&x;A");
  });
});
