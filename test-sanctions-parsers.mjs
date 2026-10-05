// Parser smoke test on tiny hand-written fixtures (no network, no DB).
import assert from "node:assert/strict";
import { parseUN, parseEU, parseUK } from "./sanctions-lists.js";

const un = parseUN(`<CONSOLIDATED_LIST><INDIVIDUALS>
 <INDIVIDUAL><DATAID>1</DATAID><FIRST_NAME>Ali</FIRST_NAME><SECOND_NAME>Hassan</SECOND_NAME><THIRD_NAME>Khan</THIRD_NAME>
  <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDi.001</REFERENCE_NUMBER>
  <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Abu Ali</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><ALIAS_NAME></ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1970-02-03</DATE></INDIVIDUAL_DATE_OF_BIRTH>
  <NATIONALITY><VALUE>Pakistan</VALUE></NATIONALITY></INDIVIDUAL></INDIVIDUALS>
 <ENTITIES><ENTITY><DATAID>2</DATAID><FIRST_NAME>Acme Front Co</FIRST_NAME><UN_LIST_TYPE>DPRK</UN_LIST_TYPE>
  <REFERENCE_NUMBER>KPe.001</REFERENCE_NUMBER><ENTITY_ALIAS><ALIAS_NAME>Acme Trading</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES>
</CONSOLIDATED_LIST>`);
assert.equal(un.length, 2);
assert.deepEqual(un[0], { uid: "QDi.001", name: "Ali Hassan Khan", type: "Individual", dob: "1970-02-03",
  nationality: "Pakistan", program: "Al-Qaida", aliases: ["Abu Ali"] });
assert.equal(un[1].type, "Entity"); assert.equal(un[1].aliases[0], "Acme Trading");

const eu = parseEU(`<export><sanctionEntity logicalId="9" euReferenceNumber="EU.1.23">
 <subjectType code="person"/><regulation programme="RUS"/><regulation programme="RUS"/>
 <nameAlias wholeName="Ivan Petrov"/><nameAlias firstName="Vanya" lastName="Petrov"/>
 <birthdate birthdate="1965-01-22"/><citizen countryDescription="RUSSIAN FEDERATION"/></sanctionEntity>
 <sanctionEntity logicalId="10"><subjectType code="enterprise"/><nameAlias wholeName="Foo LLC"/></sanctionEntity></export>`);
assert.equal(eu.length, 2);
assert.deepEqual(eu[0], { uid: "EU.1.23", name: "Ivan Petrov", type: "Individual", dob: "1965-01-22",
  nationality: "RUSSIAN FEDERATION", program: "RUS", aliases: ["Vanya Petrov"] });
assert.equal(eu[1].uid, "10"); assert.equal(eu[1].type, "Entity");

const uk = parseUK(`<Designations><Designation><UniqueID>RUS0001</UniqueID><RegimeName>Russia</RegimeName>
 <IndividualEntityShip>Individual</IndividualEntityShip>
 <Names><Name><Name1>Ivan</Name1><Name6>PETROV</Name6><NameType>Primary Name</NameType></Name>
        <Name><Name6>Vanya Petrov</Name6><NameType>Alias</NameType></Name></Names>
 <IndividualDetails><DOBs><DOB>22/01/1965</DOB></DOBs><Nationalities><Nationality>Russia</Nationality></Nationalities></IndividualDetails>
 </Designation></Designations>`);
assert.equal(uk.length, 1);
assert.equal(uk[0].name, "Ivan PETROV"); assert.equal(uk[0].aliases[0], "Vanya Petrov");
assert.equal(uk[0].dob, "1965-01-22");
console.log("parsers OK");
