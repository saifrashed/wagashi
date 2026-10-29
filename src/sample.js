'use strict';
const SAMPLE_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:element name="Library">
    <xs:annotation><xs:documentation>Root node</xs:documentation></xs:annotation>
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Name">
          <xs:annotation><xs:documentation>Name of library</xs:documentation></xs:annotation>
          <xs:simpleType>
            <xs:restriction base="xs:string"><xs:minLength value="1"/><xs:maxLength value="256"/></xs:restriction>
          </xs:simpleType>
        </xs:element>
        <xs:element name="Address" type="AddressType" minOccurs="0">
          <xs:annotation><xs:documentation>Address details of library like city name, ZIP code, street name and phone number</xs:documentation></xs:annotation>
        </xs:element>
        <xs:element name="OpeningHours" minOccurs="0">
          <xs:annotation><xs:documentation>Opening hours of library</xs:documentation></xs:annotation>
          <xs:complexType>
            <xs:sequence>
              <xs:element name="Monday" type="OpenTimeType" minOccurs="0"/>
              <xs:element name="Tuesday" type="OpenTimeType" minOccurs="0"/>
              <xs:element name="Wednesday" type="OpenTimeType" minOccurs="0"/>
              <xs:element name="Thursday" type="OpenTimeType" minOccurs="0"/>
              <xs:element name="Friday" type="OpenTimeType" minOccurs="0"/>
              <xs:element name="Saturday" type="OpenTimeType" minOccurs="0"/>
              <xs:element name="Sunday" type="OpenTimeType" minOccurs="0"/>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
        <xs:element name="ExistingSince" type="xs:date" minOccurs="0">
          <xs:annotation><xs:documentation>Library existing since</xs:documentation></xs:annotation>
        </xs:element>
        <xs:element name="Book" type="BookType" minOccurs="0" maxOccurs="unbounded">
          <xs:annotation><xs:documentation>A book in the catalogue</xs:documentation></xs:annotation>
        </xs:element>
      </xs:sequence>
      <xs:attribute name="id" type="xs:ID" use="required"/>
    </xs:complexType>
  </xs:element>

  <xs:complexType name="AddressType">
    <xs:sequence>
      <xs:element name="Country" minOccurs="0"><xs:annotation><xs:documentation>Country of library</xs:documentation></xs:annotation>
        <xs:simpleType><xs:restriction base="xs:string"><xs:maxLength value="256"/></xs:restriction></xs:simpleType></xs:element>
      <xs:element name="CityName" minOccurs="0"><xs:annotation><xs:documentation>City name of library address</xs:documentation></xs:annotation>
        <xs:simpleType><xs:restriction base="xs:string"><xs:maxLength value="256"/></xs:restriction></xs:simpleType></xs:element>
      <xs:element name="ZIP" type="xs:positiveInteger" minOccurs="0"><xs:annotation><xs:documentation>ZIP code of library address</xs:documentation></xs:annotation></xs:element>
      <xs:element name="Street" minOccurs="0"><xs:annotation><xs:documentation>Street of library address</xs:documentation></xs:annotation>
        <xs:simpleType><xs:restriction base="xs:string"><xs:maxLength value="256"/></xs:restriction></xs:simpleType></xs:element>
      <xs:element name="Phone" minOccurs="0"><xs:annotation><xs:documentation>Phone number of library</xs:documentation></xs:annotation>
        <xs:simpleType><xs:restriction base="xs:string"><xs:maxLength value="128"/></xs:restriction></xs:simpleType></xs:element>
      <xs:element name="Homepage" minOccurs="0"><xs:annotation><xs:documentation>Homepage of library (URL)</xs:documentation></xs:annotation>
        <xs:simpleType><xs:restriction base="xs:string"><xs:maxLength value="256"/></xs:restriction></xs:simpleType></xs:element>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="OpenTimeType">
    <xs:sequence>
      <xs:element name="From" type="xs:time"/>
      <xs:element name="To" type="xs:time"/>
    </xs:sequence>
  </xs:complexType>

  <xs:simpleType name="GenreType">
    <xs:restriction base="xs:string">
      <xs:enumeration value="FICTION"><xs:annotation><xs:documentation>Novels and stories</xs:documentation></xs:annotation></xs:enumeration>
      <xs:enumeration value="SCIENCE"/>
      <xs:enumeration value="HISTORY"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:complexType name="BookType">
    <xs:sequence>
      <xs:element name="Title" type="xs:string"/>
      <xs:choice>
        <xs:element name="Isbn"><xs:simpleType><xs:restriction base="xs:string"><xs:pattern value="[0-9]{13}"/></xs:restriction></xs:simpleType></xs:element>
        <xs:element name="InternalCode" type="xs:string"/>
      </xs:choice>
      <xs:element name="Genre" type="GenreType" minOccurs="0"/>
      <xs:element name="Price">
        <xs:complexType><xs:simpleContent><xs:extension base="xs:decimal"><xs:attribute name="currency" type="xs:string" use="required"/></xs:extension></xs:simpleContent></xs:complexType>
      </xs:element>
      <xs:element name="RelatedBook" type="BookType" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;
