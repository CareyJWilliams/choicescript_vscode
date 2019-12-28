import { expect } from 'chai';
import 'mocha';
import { Substitute, SubstituteOf, Arg } from '@fluffy-spoon/substitute';
import { Location, TextDocument } from 'vscode-languageserver';

import { TokenizeMultireplace } from '../../../server/src/language';

describe("Multireplace Tokenization", () => {
	it("should extract a bare variable test", () => {
		let text = "variable yes | no} extra content";

		let tokens = TokenizeMultireplace(text);

		expect(tokens.test.text).to.equal("variable");
		expect(tokens.test.index).to.equal(0);
	});

	it("should extract a parenthesized test", () => {
		let text = "(var1 + var2) yes | no} extra content";

		let tokens = TokenizeMultireplace(text);

		expect(tokens.test.text).to.equal("var1 + var2");
		expect(tokens.test.index).to.equal(1);
	});

	it("should extract the bodies", () => {
		let text = "variable yes | no | maybe } extra content";

		let tokens = TokenizeMultireplace(text);

		expect(tokens.body[0].text).to.equal("yes");
		expect(tokens.body[0].index).to.equal(9);
		expect(tokens.body[1].text).to.equal("no");
		expect(tokens.body[1].index).to.equal(15);
		expect(tokens.body[2].text).to.equal("maybe");
		expect(tokens.body[2].index).to.equal(20);
	})

	it("should find the end index", () => {
		let text = "variable yes | no} extra content";

		let tokens = TokenizeMultireplace(text);

		expect(tokens.endIndex).to.equal(18);
	})
})